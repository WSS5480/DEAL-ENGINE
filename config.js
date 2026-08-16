/* Deal Finder — site configuration.
 *
 * Put your Google Street View Static API key here and every device that opens
 * the site gets property photos. Leave it empty and the app falls back to a key
 * pasted into the Street photos panel, which stays on that one phone.
 *
 * Yes, a key here is visible to anyone who views source. That is the documented,
 * supported pattern for Google's static APIs — the protection is restrictions,
 * not secrecy. Before you commit a key, set BOTH of these in Google Cloud →
 * Credentials → your key:
 *
 *   Application restriction   Websites
 *                             https://deal-engine-app.onrender.com/*
 *                             (include the scheme and the trailing /*)
 *
 *   API restriction           Street View Static API   — and nothing else
 *
 * Without those two, anyone who finds the key can spend against your quota. With
 * them, the key is worthless off your domain.
 *
 * Also: enable "Street View Static API" on the project. A general Maps key does
 * not carry it, and that is the commonest reason photos never appear.
 *
 * 10,000 image loads a month are free. Metadata checks are free and unlimited.
 * Set a budget alert anyway.
 */
window.DE_CONFIG = {
  streetViewKey: "AIzaSyCGX0yhftlouLhO9btLzb3YKgecE1zCQJk"
