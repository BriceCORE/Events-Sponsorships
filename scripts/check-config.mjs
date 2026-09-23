const {VITE_SUPABASE_URL: url, VITE_SUPABASE_PUBLISHABLE_KEY: key, VITE_WORKSPACE_ID: workspace} = process.env;
if (!url || !key || !workspace) throw new Error('Set the three VITE_ repository variables from README.md before deploying.');
if (new URL(url).protocol !== 'https:') throw new Error('Use your HTTPS Supabase project URL.');
if (!key.startsWith('sb_publishable_')) throw new Error('Use a Supabase publishable key, never a secret or service-role key.');
console.log('Shared workspace build settings are present.');
