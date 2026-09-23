import {useEffect, useState, type ReactNode} from 'react';
import type {Session} from '@supabase/supabase-js';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {supabase, localPreview, clearSnapshot, authLinkType, authLinkError} from '@/lib/shared-client';

export function CoreBrand() {
  return <div className="core-brand"><img src={import.meta.env.BASE_URL + 'brand/core-logo.png'} alt="CORE"/><div className="core-region"><strong>CORE Midwest</strong><span>Events & Sponsorships</span></div></div>;
}

export function AuthGate({children}: {children: ReactNode}) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(localPreview || !supabase);
  const [email, setEmail] = useState(''), [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState(authLinkError);
  const [passwordSetup, showPasswordSetup] = useState(false);
  useEffect(() => {
    if (!supabase || localPreview) return;
    // Supabase consumes an invitation/recovery fragment on initialization.
    const invite = authLinkType;
    let mounted = true;
    supabase.auth.getSession().then(({data, error}) => {if (mounted) {setSession(data.session); setReady(true); if (invite && data.session && !authLinkError) showPasswordSetup(true); if (error) setError(error.message);}});
    const {data} = supabase.auth.onAuthStateChange((event, next) => {
      if (!mounted) return;
      setSession(next); setReady(true);
      if (event === 'PASSWORD_RECOVERY' && next) showPasswordSetup(true);
      if (event === 'SIGNED_OUT') {clearSnapshot(); showPasswordSetup(false); setPassword('');}
    });
    return () => {mounted = false; data.subscription.unsubscribe();};
  }, []);
  if (localPreview) return children;
  if (ready && session && !passwordSetup) return <div key={session.user.id}>{children}</div>;
  return <div className="auth-shell"><CoreBrand/><section className="auth-card">
    {!supabase ? <><p className="eyebrow">SHARED WORKSPACE</p><h1>Connect CORE Midwest.</h1><p>Your GitHub Pages app is ready. Connect its shared database to enable team sign-in, spending assignments, and benefit reviews.</p><ol><li>Create the Supabase project and run the included database setup.</li><li>Add the three connection settings listed in the setup guide.</li><li>Invite your team and import the private workspace file once.</li></ol><p className="auth-hint">Open README.md in the source package for the complete setup guide.</p></> : !ready ? <p>Opening your workspace…</p> : <>
      <p className="eyebrow">TEAM WORKSPACE</p><h1>{passwordSetup ? 'Set your password.' : 'Welcome to CORE Midwest.'}</h1><p>{passwordSetup ? 'Choose a password to finish your invitation or password reset.' : 'Sign in to review organization spending and the value of your sponsorships.'}</p>
      <form onSubmit={async e => {e.preventDefault();setBusy(true);setError('');setMessage('');try {
        if (passwordSetup) {const {error} = await supabase!.auth.updateUser({password}); if (error) throw error; showPasswordSetup(false);setPassword('');}
        else {const {error} = await supabase!.auth.signInWithPassword({email: email.trim(), password});if (error) throw error;}
      } catch (e) {setError((e as Error).message);} finally {setBusy(false);}}}>
        {!passwordSetup && <label className="field-label">Work email<Input type="email" autoComplete="username" required value={email} onChange={e => setEmail(e.target.value)}/></label>}
        <label className="field-label">{passwordSetup ? 'New password' : 'Password'}<Input type="password" autoComplete={passwordSetup ? 'new-password' : 'current-password'} minLength={passwordSetup ? 12 : undefined} required value={password} onChange={e => setPassword(e.target.value)}/></label>
        {error && <p role="alert" className="form-error">{error}</p>}{message && <p role="status">{message}</p>}
        <Button type="submit" disabled={busy}>{busy ? 'Please wait…' : passwordSetup ? 'Save password' : 'Sign in'}</Button>
      </form>
      {!passwordSetup && <Button variant="link" disabled={busy} onClick={async () => {
        if (!email.trim()) {setError('Enter your work email first.');return;}setBusy(true);setError('');
        const {error} = await supabase!.auth.resetPasswordForEmail(email.trim(), {redirectTo: new URL(import.meta.env.BASE_URL, window.location.href).href});
        if (error) setError(error.message);else setMessage('If this email has access, a password reset link will arrive shortly.');setBusy(false);
      }}>Forgot password?</Button>}
      <p className="auth-hint">Access is by invitation. Your workspace owner manages membership.</p>
    </>}
  </section><p className="auth-footer">CORE Midwest · Relationships, dollars & benefits</p></div>;
}
