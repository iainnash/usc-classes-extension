#!/usr/bin/env node

/*
** Author: Iain Nash
** Date: Wed Oct 22nd
** Title: Gocardless Interview Challenge
** Description: A site spider that pulls in page resources. Outputs json.
** Install: npm install request yargs cheerio
** Run examples: 
**  no spider resources:
**    node resource-spider.js http://gocardless.com -o output.json
**  with spider resources: 
**    node resource-spider.js http://gocardless.com -o output.json --resources_out resources.json
*/

var request = require('request')  // npm package: used to make HTTP requests cleanly.
  , yargs   = require('yargs')    // npm package: used to parse command line arguments.
  , url     = require('url')      // included node package: used to wrangle URLs.
  , fs      = require('fs')       // included node package: used to write the file output.
  , cheerio = require('cheerio'); // npm package: used to load and parse the DOM.

 var redis = require("redis"),
     client = redis.createClient();

// Global State Variables for the Scraper Script
var baseUrl = null
  , coursesOut = {}
  , updateResources = false
  , classesToLoad = new Queue(new ClassDeptProcessor())
  , loadClassList = new Queue(new ClassesProcessor());

// Main function.
function main() {
  var argv = yargs
    // Require the webpage URL
    .demand(1)
    // Usage line
    .usage('Usage: $0 $1 [year] -o [output filename]')
    // # of workers (higher number will have speedup, but more server / client load)
    .options('w', {
        alias: 'workers',
        default: 5,
        describe: 'Number of workers'
    })
    // Output file
    .options('o', {
      alias: 'output',
      describe: 'Output File',
      demand: true,
      default: 'redis'
    })
    // Debug print frequency (-1 to disable).
    .options('d', {
      alias: 'debug',
      describe: 'Debug log frequency (higher is less often) (-1 disables)',
      default: 5
    })
    // Also spider resources - produces a separate output file.
    .describe('resources_out', 'Parse resources for dependencies and output to given file.')
    .options('l', {
      alias: 'limit',
      describe: 'Limit to fetching N pages (for debugging / speed)'
    })
    .argv;

  // We can now safely assume that argv.o and argv.w exist (and have one input).
  var startUrl = argv._[0];
  
  // Setting script-wide variables.
  baseUrl = url.parse(startUrl);

  // Information message.
  console.log('Starting spider with base: ' + baseUrl.hostname);

  classesToLoad.setDebug(argv.debug);
  classesToLoad.setWorkers(argv.workers);

  loadClassList.setDebug(argv.debug);
  loadClassList.setWorkers(argv.workers);

  if (argv.limit) {
    classesToLoad.setLimit(argv.limit);
    loadClassList.setLimit(argv.limit);
  }

  // When the pages are done loading.
  loadClassList.onDone(function() {
  	classesToLoad.start();
  });

  classesToLoad.onDone(function() {
    if (argv.output == 'redis') {
      console.log('done!');
      process.exit(0);
    } else {
      fs.writeFileSync(argv.output, JSON.stringify(coursesOut));
    }
  });

  // Kick off loading pages with a start url
  loadClassList.add(startUrl);
  // and start.
  loadClassList.start();

}
main();

/*
** URL Resource Utilities
*/

// Checks the protocol of the URL, 
//   makes sure that the subdomain is correct if there is an attached host.
function validateUrl(link) {
  if ((url.protocol != null 
    && url.protocol.indexOf('http') == -1)
    || (url.host != null 
    && !isInSubdomain(url.hostname))) {
    return false;
  }
  return true;
}
// End URL Resource Utilities

/*
** Content Processing Functions
*/


function ClassesProcessor() {
	this.process = function(classes_url) {
		request(classes_url, function (error, response, body) {
			if (!error && response.statusCode == 200) {
				startUrl = response.request.uri.href;
				$p = cheerio.load(body);
				$p('#sortable-classes li[data-type=department]').find('a').each(function() {
					var classes_fetch = this.attribs['href'];
					if (classes_fetch) {
						classesToLoad.addUnique(classes_fetch);
					}
				})
			}
		loadClassList.processingDone();
		});
	}
}

function ClassDeptProcessor() {
	this.process = function(department_url) {
		console.log(department_url);
		request(department_url, function (err, resp, body) {
			if (!err && resp.statusCode == 200) {
				$p = cheerio.load(body);
				$p('.course-info').each(function() {
					var $ci = $p(this);
					var link = $ci.find('.courselink');
					var courseNum = link.find('strong').text();
					var units = link.find('span.units').text();
					var title = link.text();
					var name = link.remove('*').html();
          var section_data = [];
          $ci.find('tr[data-section-id]').each(function(i, sect){
            var classesInfo = ['section', 'type', 'time', 'days', 'registered', 'instructor'];
            var atSection = $p(sect);
            var sectionPart = {};
            for (var i = 0; i < classesInfo.length; i++) {
              sectionPart[classesInfo[i]] = atSection.find('.' + classesInfo[i]).text();
            }
            sectionPart.building = atSection.find('.location a').text();
            sectionPart.room = atSection.find('.location').children().remove().end().text();
            sectionPart.raw = $p(sect).html();
            if (sectionPart.instructor && sectionPart.instructor != '') {
              client.hset('course-teacher', sectionPart.section, sectionPart.instructor);
            }   
            section_data.push(sectionPart);        
          });

          var courseKey = courseNum.replace(' ', '-').replace(/:$/, '')
					coursesOut[courseKey] = {
						link: link.attr('href'),
						num: courseNum.replace(/ ?:$/,''),
						units: units,
						title: title,
						name: name,
            sections: section_data,
            description: $ci.find('.catalogue').html(),
            notes: $ci.find('.notes').html()
					}
          client.set(courseKey.toLowerCase(), JSON.stringify(coursesOut[courseKey]));
				});

			}
			classesToLoad.processingDone();
		});
	}
}


/*
** Specialized Queue for keeping track of workers and callbacks.
*/
function Queue(workerFunction) {
  // Internal State
  var size = 0
    , pending = 0
    , workers = 0
    , numRunningWorkers = 5
    , debugLevel = -1
    , logsize = 0
    , runlimit = -1
    , elements = []
    , unique_lookup = {};

  // Callbacks.
  var donecb = [];

  // Add an onDone callback.
  this.onDone = function(new_fn) {
    donecb.push(new_fn);
  }
  this.setDebug = function(newDebug) {
    debugLevel = newDebug;
  }
  this.setWorkers = function(newWorkers) {
    numRunningWorkers = newWorkers;
  }
  this.setLimit = function(newLimit) {
    runlimit = newLimit;
  }

  // Internal Getters
  this.workers = function() {
    return workers;
  }
  this.pending = function() {
    return pending;
  }
  this.empty = function() {
    return elements.length == 0;
  }
  this.getUnique = function() {
    return unique_lookup;
  }

  this.setResource = function(key, val) {
    unique_lookup[key] = val;
  }

  // Debug log function
  this.log = function() {
    console.log('[info] pending: ' + pending + '\tworkers: ' + workers + '\tqueued: ' + logsize);
  }

  // Add an element to process.
  this.add = function(el) {
    // Able to add if (logsize > N) return; to artificially shorten log for testing.
    
    // Enforce run limiting for debugging.
    if (runlimit > 0 && logsize >= runlimit)
      return;

    elements.push(el);
    logsize += 1;
    pending += 1;
  }
  this.start = function() {
    var el = this.drain();
    if (el) {
      workers += 1;
      workerFunction.process(el);
    }
  }
  this.addUnique = function(el) {
    if (unique_lookup[el] === undefined) {
      // Creates an empty object to fill out later.
      unique_lookup[el] = true
      this.add(el)
      // Added element.
      return true;
    }
    // Didn't add element.
    return false;
  }
  // Remove an element from the list.
  this.drain = function() {
    return elements.shift();
  }
  // After the worker finishes, run this callback.
  this.processingDone = function () {
    pending -= 1;
    workers -= 1;
    // If we're done, mark this as done.
    if (pending <= 0) {
      donecb.forEach(function(cb_el) {
        cb_el();
      })
    } else {
      // Move on to the next element
      while (workers < numRunningWorkers) {
        var newJob = this.drain();
        if (newJob) {
          workers += 1;
          workerFunction.process(newJob);
        } else { break }
      }
      if (debugLevel != -1 && pending % debugLevel == 0) {
        this.log();
      }
    }
  }
}

