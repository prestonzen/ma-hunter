/**
 * The browser clipper: a bookmarklet that runs on a marketplace page in your own browser (where you are
 * signed in and the site lets you read it), gathers the page's text and listing links, and hands them to
 * the hub's /clip page in a new tab. Nothing is sent anywhere else, and nothing is saved until you press
 * Save on the preview.
 *
 * It is self-contained on purpose: a page's content-security policy can block a bookmarklet from loading
 * an outside script or calling fetch(), but it can't stop it opening a tab and posting a message to it.
 */

/** Listing-page URL shapes on the big marketplaces, used to find result cards on a search page. */
export const LISTING_URL_SOURCE =
  "bizbuysell\\.com/(business-opportunity|business-for-sale|franchise-for-sale)/[^/?#]+/\\d+|bizquest\\.com/(business-for-sale|listing)/[^?#]*\\d{4,}|flippa\\.com/\\d{6,}|businessbroker\\.net/(business-for-sale|listings)/[^?#]*\\d{4,}|businessesforsale\\.com/[^?#]*/[\\w-]+\\.aspx|loopnet\\.com/biz/[^?#]*\\d{5,}|dealstream\\.com/[^?#]*/\\d{4,}|empireflippers\\.com/listing/\\d+|acquire\\.com/(startup|listing)s?/[\\w-]+|quietlight\\.com/listings/\\d+|websiteclosers\\.com/businesses-for-sale/[\\w-]+";

export function bookmarklet(origin: string): string {
  const code = `(function(){
var H=${JSON.stringify(origin)},d=document,RE=new RegExp(${JSON.stringify(LISTING_URL_SOURCE)},'i');
function q(s,r){return [].slice.call((r||d).querySelectorAll(s))}
function hits(el){var o={};q('a[href]',el).forEach(function(a){var h=a.href.split('#')[0].split('?')[0];if(RE.test(h))o[h]=1});return Object.keys(o).length}
var ld=q('script[type="application/ld+json"]').map(function(s){try{return JSON.parse(s.textContent)}catch(e){return null}}).filter(Boolean);
var meta={};q('meta[name],meta[property]').forEach(function(m){var k=(m.getAttribute('property')||m.getAttribute('name')||'').toLowerCase();if(k&&m.content)meta[k]=m.content});
var emails=q('a[href^="mailto:"]').map(function(a){return decodeURIComponent(a.href.slice(7).split('?')[0])});
var phones=q('a[href^="tel:"]').map(function(a){return a.href.slice(4)});
var cards=[],seen={};
q('a[href]').forEach(function(a){var h=a.href.split('#')[0].split('?')[0];if(!RE.test(h)||seen[h]||h===location.href.split('#')[0].split('?')[0])return;seen[h]=1;
var el=a;while(el.parentElement&&el.parentElement!==d.body&&hits(el.parentElement)<=1)el=el.parentElement;
var t=(el.innerText||a.innerText||'').trim();if(t.length<12)return;
var title=((q('h1,h2,h3,h4',el)[0]||a).innerText||'').trim().split('\\n')[0];
cards.push({url:h,title:title||t.split('\\n')[0],text:t.slice(0,1500)})});
var p={type:'mah-clip',page:{url:location.href,title:d.title,text:(d.body.innerText||'').slice(0,200000),jsonld:ld,meta:meta,emails:emails,phones:phones},cards:cards.slice(0,80)};
var w=window.open(H+'/clip','mahclip');
if(!w){alert('M&A Hunter: allow pop-ups for this site, then click the clipper again.');return}
var n=0,t=setInterval(function(){try{w.postMessage(p,H)}catch(e){}if(++n>60)clearInterval(t)},500);
window.addEventListener('message',function(e){if(e.origin===H&&e.data==='mah-got')clearInterval(t)});
})()`;
  return `javascript:${encodeURIComponent(code.replace(/\n/g, ""))}`;
}
