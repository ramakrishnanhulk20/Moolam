/**
 * The one redirect the web performs: an address with no language in it goes to
 * the same address in the reader's language. /verify becomes /ta/verify for a
 * phone set to Tamil, and /en/verify for a language the site does not carry.
 *
 * It runs in the browser, before the page is painted, because nothing on the
 * server can see the reader's languages without a proxy on every route and
 * that proxy is kept to Explore on purpose. The target is always "/", a
 * language from `locales`, and the current path, query and hash, so it stays
 * on the same origin and never reads a destination from the address. A path
 * that already starts with a language is left alone, so a miss under one can
 * never loop, and so are Next's own files and the API.
 *
 * The line stands down when the page is already hidden, because the root
 * not-found page writes it twice and whichever copy runs first has already
 * sent the reader on.
 */
export function languageRedirect(locales: readonly string[], fallback: string): string {
  return `(function(){var l=${JSON.stringify(locales)},p=location.pathname,s=p.split("/")[1]||"",h=document.documentElement;if(h.style.visibility==="hidden"||l.indexOf(s)!==-1||s==="_next"||s==="api")return;var w=navigator.languages&&navigator.languages.length?navigator.languages:[navigator.language||""],c=${JSON.stringify(fallback)};for(var i=0;i<w.length;i++){var b=String(w[i]).toLowerCase().split("-")[0];if(l.indexOf(b)!==-1){c=b;break}}h.style.visibility="hidden";location.replace("/"+c+(p==="/"?"":p)+location.search+location.hash)})();`;
}
