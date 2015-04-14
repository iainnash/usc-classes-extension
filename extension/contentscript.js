var s = document.createElement('script');
s.src = chrome.extension.getURL('script.js');
//(document.head||document.documentElement).appendChild(s);
var s2 = document.createElement('script');
s2.src = 'https://ajax.googleapis.com/ajax/libs/jquery/1.9.1/jquery.min.js';
(document.head||document.documentElement).appendChild(s2);
s2.onload = function() {
	s2.parentNode.removeChild(s2);
	(document.head||document.documentElement).appendChild(s);
}
s.onload = function() {
    s.parentNode.removeChild(s);
};
