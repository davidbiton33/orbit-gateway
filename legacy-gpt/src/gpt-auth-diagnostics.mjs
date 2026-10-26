/**
 * Read-only, privacy-minimizing diagnostics for the ChatGPT editor page.
 * Never collect page body text, prompt contents, cookies, auth tokens or URLs.
 */
export function classifyChatGptProbe({httpStatus=null, pathname='/', title='', editorVisible=false, loginForm=false, cloudflareMarker=false, accountControl=false, timedOut=false}={}) {
  const normalized=String(title).slice(0,128);
  const challenged=cloudflareMarker || /just a moment|verify (?:you are )?human|checking your browser|attention required|בדיקת אבטחה|אימות אנושי/i.test(normalized) || [403,429].includes(httpStatus);
  const login=/^\/(?:auth|login|sign-in|signin)(?:\/|$)/i.test(String(pathname)) || loginForm;
  let verdict = 'editor_or_session_unknown';
  if (editorVisible) verdict='editor_ready';
  else if (challenged) verdict='challenge_or_denied';
  else if (login) verdict='login_required';
  else if (timedOut) verdict='editor_missing_or_ui_changed';
  return {verdict, http_status:httpStatus, editor_visible:Boolean(editorVisible), challenge_detected:Boolean(challenged), login_detected:Boolean(login), account_control_visible:Boolean(accountControl)};
}
