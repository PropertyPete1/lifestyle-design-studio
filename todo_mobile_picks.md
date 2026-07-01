# BUG: Mobile shows "No picks available yet" (Jul 1, recurring)

Screenshot: app shell renders (header/nav visible) but picks.today returns empty on phone.

- [x] DB: today (2026-07-01) HAS picks (SA + Austin)
- [x] picks.today returns 200 with 2 picks in 528ms; auth.me shows Peter Allen/admin — data + auth are fine
- [x] Root cause: phone rendered a STALE cached JS bundle (empty state) from before today's picks/redeploy; UI collapses error+empty into the same dead-end message
- [x] Home: distinguish query ERROR (isError -> Retry) from genuinely EMPTY (-> Refresh); no more collapsed dead-end
- [x] Add useBuildFreshness hook: checks /__manus__/version.json on load + tab focus; one-time hard reload when deployed version changes (kills stale bundle)
- [x] refetchOnWindowFocus + refetchOnReconnect + retry:2 so returning to the PWA recovers automatically
- [x] Type-check clean + 64 tests pass
- [ ] User publishes; verify on phone (should self-recover even from a stale cache)
