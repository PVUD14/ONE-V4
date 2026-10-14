import { Icon } from './icons/Icon.js';
import type { AuthStatus } from './auth.js';

export function AuthControls({ authStatus, notice, onSignIn, onSignOut }: { readonly authStatus: AuthStatus; readonly notice: string; readonly onSignIn: () => void; readonly onSignOut: () => void }): React.ReactElement {
  if (authStatus.state === 'restoring') {
    return <div className="auth-controls"><span>Restoring session...</span></div>;
  }
  if (authStatus.state === 'authenticated') {
    return <div className="auth-controls"><span>Account</span><span>{authStatus.email ?? 'Signed in'}</span><button type="button" className="secondary auth-sign-out" onClick={onSignOut}><Icon name="logout" size={16} /><span className="auth-sign-out-label">Sign out</span></button></div>;
  }
  return <div className="auth-controls"><span>{notice}</span><button type="button" onClick={onSignIn} disabled={authStatus.state === 'unconfigured'}>Sign in</button></div>;
}
