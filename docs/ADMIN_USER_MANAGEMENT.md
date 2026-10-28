# Admin user management setup

The web interface calls the Supabase Edge Function `manage-users`. The function uses the caller's access token and the existing `is_app_admin()` RPC to authorize every request. The Supabase service-role key is read only from the Edge Function environment and must never be added to `index.html`.

## Deploy the function

Run these commands from the repository root in a terminal with the Supabase CLI installed:

```sh
supabase login
supabase link --project-ref btggzmfvubvizrgfbckp
supabase functions deploy manage-users
```

Supabase provides `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` to deployed Edge Functions. Do not put the service-role key in source code or Cloudflare Pages environment variables.

## Account behavior

- Username is converted to a synthetic email of the form `username@step2-stock-demo.invalid`, matching the current login screen's username-to-email convention.
- New accounts are email-confirmed so they can sign in immediately with the username and password.
- Usernames are lowercase and accept 3–32 characters: `a-z`, `0-9`, dot, underscore, hyphen.
- Passwords must be 8–72 characters.
- New accounts are ordinary staff accounts; this UI does not grant Admin permissions.
- Listing currently returns the first 1,000 Auth users.
- Deletion is blocked for the caller's own account and for Auth accounts that do not use the inventory app's synthetic email suffix.

## Before using

1. Deploy the Edge Function to the Supabase project used by the app.
2. Verify the existing `is_app_admin()` RPC returns `true` for the intended administrator and `false` for staff.
3. Test create/login/delete with a temporary staff username before managing real staff accounts.
4. Keep the change on the feature branch until preview testing is complete; do not merge to `main` without approval.

The GitHub commit only adds the source code. It does not deploy the function to Supabase or change any database records by itself.
