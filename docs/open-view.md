# Watching the ward without a token

A viewer build (`VITE_VIEW_API_URL` set) with no token asks `GET {VIEW_API}/wards/W4/open-view` first; while the answer stays valid it asks again 2 s after each answer. Wire contract: `contract-open-view` v1.1. Code: `src/open-view.ts`.

## What the page does

- A valid body: the page draws the ward read-only, shows "Watching, read-only" and a "Sign in to control" button, and asks again 2 s after each answer or failure.
- The first request waits up to 15 s (every later one 5 s): from outside, the open view took 1.6 to 3.2 s on a quiet server, so 5 s failed under load.
- The server could not be reached on the first request (5xx, network error, timeout): the page says "Server not reachable, trying again" and asks again after 5 s, 10 s, 20 s, then every 30 s. The read-only view opens by itself when the server answers. "Sign in instead" shows the sign-in form. The page never falls to a bare sign-in form because the server was slow.
- Anything else on the first request (404, other status, bad body): the sign-in form, at once. The server's public view is off, so there is nothing to wait for.
- While watching: a 5xx, network error or timeout keeps the last picture and shows "Not updating". A redirect (301, 302, 303, 307, 308) is refused and counts as a network error: "Not updating", and polling goes on. Any other status from 201 to 499, or a bad or over-cap body, ends the watch and shows sign-in. There is no retry until a reload.
- "Sign in to control" leaves watching and shows sign-in. After a sign-in the page works as before and never calls the open route. A 401 from `/live` or from a command tries the open route once more. A signed-in viewer has a "Sign out" button in the top bar: it drops the token and asks the open route once, so the page returns to watching if the route answers and to the sign-in form if not.
- A bed is tagged only when both rank and risk are set. It is grey when risk is null. So a not-ranked bed shows no NR tag. The side panel has no "Not ranked (NR)" line. Figures are coloured by role only.
- With a token present, no open-view request is made at all. A build without `VITE_VIEW_API_URL` is unchanged.

## The whole hospital, when the server runs one

Code: `src/open-hospital.ts` (pure) and `src/open-panels.tsx`. Tests: `src/open-hospital.test.tsx`.

- While watching, the page asks `GET {VIEW_API}/open-view` for the run's units (id, name, floor, kind) at once and then once a minute. It keeps only the units the building draws; a unit the page cannot draw is left out. A 404 means there is no list: the page asks no other unit and is the ward, as before.
- It then asks the open route of each other listed unit, one unit at a time in turn.
- If any of them answers, the server runs a whole hospital. The page then draws the building: building, floor, bed. The side panel has a breadcrumb ("Hospital › 3F Medicine 3A › Bed ..."), Escape goes up one level, and the top bar says "Hospital" and "Server clock".
- If none answers (404: the server runs ward W4 alone), the page is the ward, exactly as described above. A unit that answered 404 is asked again once a minute, so the page follows the server without a reload.
- What is real: which beds are in use in each unit, and each bed's NEWS2 band and rank where the unit is ranked. The ER's beds are grey (shown, not ranked) and intensive care's carry no NEWS2 colour at all.
- What is not from the server: where a bed is drawn inside its unit. The open answer has no positions, so beds fill the unit's drawn beds in the list's order, ranked first. Figures outside W4 have one neutral look and no name, age, group or triage. Nurses outside W4, the ER queue and the morgue are not drawn.
- A click selects a floor or a bed in use, nothing else.
- **A bed's card.** Picking a bed asks `GET {VIEW_API}/wards/{unit}/open-view/beds/{bed}` once. The card shows exactly what comes back, under the words "Synthetic data". A ranked bed: the NEWS2 score and band, the trend, and the newest heart rate, respiratory rate, SpO2, temperature and blood pressure, each with its source and its age in ward time ("12 min ago"). Any other bed (a bed that is not ranked, the ER, intensive care): "Not ranked" and the reason, nothing else. A 404: "This bed is empty now." A failure: "No answer from the server. Pick the bed again to ask once more." The card is never polled and never retried by the page; another pick ends a request in flight. The page shows no name, and keeps no field the contract does not list.
- The age of a vital is the ward's clock (the ward's start plus the clock the open answer gives) minus the time on the vital. A time ahead of the ward's clock reads "just now".
- Pace (rule 8): no route is asked more often than every 2 s. W4 is asked every 2 s as before. Each other unit is asked once when the page opens (200 ms apart, so the building fills in about a second), then one of them every 2 s in turn, which is each of them every 10 s.
- Rule 5: the three requests above are all open routes; no other route is called without a token.
- Rule 6 for these units: a bed label that passed the label pattern is shown as a text node in the list and the card, and is sent back as one encoded path part of the bed's own open route. A unit's name and a card's reason are text nodes too. None is ever used as HTML, a link, a selector or a style.

## The hospital admin (signed in)

Code: `src/admin-view.ts` (pure) and `src/admin-panels.tsx`. Tests: `src/admin-view.test.tsx`. Owner decision orch-h11.

- The sign-in list has one more entry, "Hospital admin". The passphrase is typed by the person. The role comes from the API's answer to the sign-in, never from the entry picked.
- A reader with the admin role keeps the public drawing (the open view, asked without the token, as for a watcher) and gets the side panel "Hospital admin": every unit with its patient count; a unit's patients with name, bed, NEWS2 score, rank, trend and the five vitals; the unit's history (stays that ended, newest first); one patient's page with each vital's source and age. The top bar says "Hospital admin" and "Read-only".
- Routes, with the token: `GET /wards` (at sign-in and every 10 s), `GET /wards/{unit}/rows` and `GET /wards/{unit}/stays` (when a unit is opened and every 10 s while it is open), `GET /patients/{id}` (once per pick). Nothing is asked faster than that. A 401 signs the reader out.
- Read-only: the panel has no control, the top bar has only "Sign out", and the admin's page never reads a unit's live view (`/wards/{unit}/live` is for the unit's own clinicians), so it never learns `can_control`.
- A row with no vitals in the answer says "Vitals not served yet." and shows none. Today that is every ER and intensive care row. A value the server marks absent shows as "none". Nothing is filled in.
- Ages are measured against the `now` the route serves, so they hold for any run.
- With no open view there is no drawing, and the stage says why: "Server not reachable. No drawing is shown." when the open route cannot be reached, or "No drawing: the server's public view is off. The lists still come from the server." when it answers 404. A viewer build starts from an empty world and never runs its own engine, so no patient of the page's own is ever drawn beside the server's data.
- Vitals that are missing from an answer read "Vitals not served yet."; vitals that are there but out of shape read "Could not read the vitals in this answer." and none of them is shown.
- A clinician's page is unchanged.

## The nine rules (wire contract, section 9.1), and where they are tested

1. No credential to the open route: `credentials: "omit"`, no `headers` key at all (a simple GET), `redirect: "error"`.
2. No name or title for a figure: staff are named only "Nurse", "Charge nurse", "Physician".
3. Nothing is stored: no browser storage and no cookie. `cache: "no-store"`. Checked by a source scan of `src/open-view.ts` and `src/App.tsx` only.
4. No control without a token: the top bar has no speed button or Reset (the speed shows as text, read-only), the side panel has no control button (its only buttons are the bed rows, which select a bed on this page and send nothing), and `/live` is not read.
5. No other API call without a token.
6. No string from the answer reaches markup. Bed labels must match `[A-Za-z0-9][A-Za-z0-9 ._-]{0,19}`. W4's are only matched against the map's `BEDS`; another unit's are shown as text nodes only (see "The whole hospital").
7. Unknown keys are ignored and never read.
8. Poll every 2 s, not faster: the next request is scheduled 2 s after the last answer or failure, one at a time.
9. No logging of the answer.

Tests are in `src/open-view.test.ts` and `src/open-view.draw.test.ts`. The guards inside `src/App.tsx` (rules 4 and 5, click, hover, select list) are checked by scans of its source, not by mounting the page.

## Limits of the body

At most 64 KiB, read with a byte count, and a 5 s timeout. `clockS` at most 1e9. At most 100 beds, 20 staff and 20 moves. `ward` must equal `W4`. Any field out of shape, any unknown enum value, any number not finite or out of range refuses the whole body.

## Limits

- Synthetic data only. The route serves a synthetic run only.
- The API route may not exist yet, or may be off. Then the page is as before: the sign-in form.
