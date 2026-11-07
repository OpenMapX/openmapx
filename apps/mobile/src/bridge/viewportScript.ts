/**
 * Locks the page at its layout scale.
 *
 * A native app does not let the whole interface be pinched or double-tapped
 * larger; only the map zooms, and it does that with its own gesture handling,
 * which a viewport scale limit does not affect. The web product keeps browser
 * zoom for visitors in a browser, so the shell narrows the viewport itself
 * rather than the page shipping a fixed scale to everyone.
 *
 * The program keeps whatever else the page declares (width, `viewport-fit`)
 * and replaces only the scale keys. It reapplies itself if the page later
 * rewrites or replaces the tag. It publishes nothing on `window` and is fixed
 * text with no interpolation.
 */
export const VIEWPORT_LOCK_SCRIPT = `(function(){try{
var S=["initial-scale=1","minimum-scale=1","maximum-scale=1","user-scalable=no"];
var K=/^(initial-scale|minimum-scale|maximum-scale|user-scalable)$/i;
function want(c){
var p=(c||"").split(",").map(function(s){return s.trim();}).filter(function(s){
return s&&!K.test(s.split("=")[0].trim());});
if(!p.length){p.push("width=device-width");}
return p.concat(S).join(",");}
function lock(){
var m=document.querySelector('meta[name="viewport"]');
if(!m){m=document.createElement("meta");m.setAttribute("name","viewport");
(document.head||document.documentElement).appendChild(m);}
var c=m.getAttribute("content");var w=want(c);
if(c!==w){m.setAttribute("content",w);}}
lock();
new MutationObserver(lock).observe(document.head||document.documentElement,
{childList:true,subtree:true,attributes:true,attributeFilter:["content","name"]});
}catch(e){}})();true;`;
