/* Deployment settings. Both values are safe in a public repository: the
   spreadsheet ID identifies a Sheet that is NOT published to the web, and an
   OAuth client ID is a public identifier by design. Reading the Sheet still
   requires the viewer to sign in with a Google account that the Sheet has
   been shared with.

   CLIENT_ID comes from Google Cloud Console -> APIs & Services ->
   Credentials -> Create OAuth client ID -> Web application, with this site's
   origin (https://<user>.github.io) added as an authorised JavaScript origin.
   Leave it empty and the page says what is missing instead of failing. */
window.ICMS_CONFIG = {
  SPREADSHEET_ID: "1Xje5N98hWKZEOJu7mzv_w6Z7eppwQC3W-jx1oB2q2g4",
  CLIENT_ID: "458793465029-i671uh5eo7rr2np2486qkkf7na88tfql.apps.googleusercontent.com",
  DIVISION: "Delhi Division (DLI), Northern Railway"
};
