/** Read-only share links (#76): `…/?share=<token>`. */

export const SHARE_PARAM = 'share';
const TOKEN = /^[A-Za-z0-9_-]{8,128}$/;

/** The share token in a query string, or null (malformed tokens are ignored). */
export function shareTokenFrom(search: string): string | null {
  const token = new URLSearchParams(search).get(SHARE_PARAM);
  return token && TOKEN.test(token) ? token : null;
}

/** Share URL for a token, based on the current page (other query parameters and the hash are dropped). */
export function shareUrl(token: string, location: { origin: string; pathname: string }): string {
  return `${location.origin}${location.pathname}?${SHARE_PARAM}=${encodeURIComponent(token)}`;
}

/** URL of the editor (without the share parameter), to leave read-only mode. */
export function editorUrl(location: { origin: string; pathname: string }): string {
  return `${location.origin}${location.pathname}`;
}
