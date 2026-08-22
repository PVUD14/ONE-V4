import type { AuthStatus } from './auth.js';

export function AuthControls({ authStatus, notice, onSignIn, onSignOut }: { readonly authStatus: AuthStatus; readonly notice: string; readonly onSignIn: () => void; readonly onSignOut: () => void }): React.ReactElement {
  if (authStatus.state === 'restoring') {
    return <div className="auth-controls"><span>Restoring session...</span></div>;
  }
  if (authStatus.state === 'authenticated') {
    return <div className="auth-controls"><span>Account</span><span>{authStatus.email ?? 'Signed in'}</span><button type="button" className="secondary" onClick={onSignOut}>Sign out</button></div>;
  }
  return <div className="auth-controls"><span>{notice}</span><button type="button" onClick={onSignIn} disabled={authStatus.state === 'unconfigured'}>Sign in</button></div>;
}
