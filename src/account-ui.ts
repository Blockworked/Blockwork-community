// First-party script, compatible with script-src 'self'; no inline event handlers.
export const ACCOUNT_JS = String.raw`
(() => {
  const status = document.getElementById('auth-status');
  const say = text => { if (status) status.textContent = text; };
  const decode = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  const encode = value => btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  async function post(url, body) {
    const res = await fetch(url, {method: 'POST', credentials: 'same-origin', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error(res.status === 429 ? 'Too many attempts. Try again in 15 minutes.' : 'The request failed. Sign in and try again.'); }
    if (!res.ok) throw new Error(data.error || 'Verification failed.');
    return data;
  }
  function serialize(credential) {
    const r = credential.response;
    const response = {clientDataJSON: encode(r.clientDataJSON)};
    for (const key of ['attestationObject', 'authenticatorData', 'signature', 'userHandle']) if (r[key]) response[key] = encode(r[key]);
    if (r.getTransports) response.transports = r.getTransports();
    return {id: credential.id, rawId: encode(credential.rawId), type: credential.type, authenticatorAttachment: credential.authenticatorAttachment,
      clientExtensionResults: credential.getClientExtensionResults(), response};
  }
  for (const button of document.querySelectorAll('[data-passkey]')) button.addEventListener('click', async () => {
    button.disabled = true; say('Waiting for your passkey…');
    try {
      if (!window.PublicKeyCredential || !navigator.credentials) throw new Error('Passkeys require a supported browser and a secure connection.');
      const register = button.dataset.passkey === 'register';
      const label = document.getElementById('passkey-label');
      const options = await post('/auth/passkey/' + (register ? 'register-options' : 'options'), {label: label ? label.value : '', next: button.dataset.next || '/account'});
      options.challenge = decode(options.challenge);
      if (options.user) options.user.id = decode(options.user.id);
      for (const key of ['allowCredentials', 'excludeCredentials']) if (options[key]) options[key] = options[key].map(c => ({...c, id: decode(c.id)}));
      const credential = await navigator.credentials[register ? 'create' : 'get']({publicKey: options});
      if (!credential) throw new Error('No passkey was returned.');
      const result = await post('/auth/passkey/' + (register ? 'register-verify' : 'verify'), serialize(credential));
      window.location.assign(result.next);
    } catch (error) { say(error.name === 'NotAllowedError' ? 'Passkey cancelled or unavailable. Try again or use a backup code.' : error.message); }
    finally { button.disabled = false; }
  });
  for (const form of document.querySelectorAll('[data-oauth-connect]')) form.addEventListener('submit', async event => {
    event.preventDefault();
    const button = form.querySelector('button');
    button.disabled = true;
    try { const result = await post(form.action, {}); window.location.assign(result.authorization); }
    catch (error) { say(error.message); button.disabled = false; }
  });
  const totp = document.getElementById('totp-form');
  if (totp) totp.addEventListener('submit', async event => {
    event.preventDefault();
    try { const result = await post('/auth/totp/verify', {code: new FormData(totp).get('code')}); window.location.assign(result.next); }
    catch (error) { say(error.message); }
  });
  const backup = document.getElementById('backup-form');
  if (backup) backup.addEventListener('submit', async event => {
    event.preventDefault();
    try { const result = await post('/auth/backup/verify', {code: new FormData(backup).get('code')}); window.location.assign(result.next); }
    catch (error) { say(error.message); }
  });
})();
`;
