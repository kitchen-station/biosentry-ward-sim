# Watching the ward without a token

A viewer build (`VITE_VIEW_API_URL` set) with no token asks `GET {VIEW_API}/wards/W4/open-view` first; while the answer stays valid it asks again 2 s after each answer. Wire contract: `contract-open-view` v1.1. Code: `src/open-view.ts`.

## What the page does

- A valid body: the page draws the ward read-only, shows "Watching, read-only" and a "Sign in to control" button, and asks again 2 s after each answer or failure.
- Anything else on the first request (404, other status, 5xx, network error, timeout, bad body): today's sign-in form.
- While watching: a 5xx, network error or timeout keeps the last picture and shows "Not updating". A redirect (301, 302, 303, 307, 308) is refused and counts as a network error: "Not updating", and polling goes on. Any other status from 201 to 499, or a bad or over-cap body, ends the watch and shows sign-in. There is no retry until a reload.
- "Sign in to control" leaves watching and shows sign-in. After a sign-in the page works as before and never calls the open route. A 401 from `/live` or from a command tries the open route once more. There is no sign-out button.
- A bed is tagged only when both rank and risk are set. It is grey when risk is null. So a not-ranked bed shows no NR tag. The side panel has no "Not ranked (NR)" line. Figures are coloured by role only.
- With a token present, no open-view request is made at all. A build without `VITE_VIEW_API_URL` is unchanged.

## The nine rules (wire contract, section 9.1), and where they are tested

1. No credential to the open route: `credentials: "omit"`, no `headers` key at all (a simple GET), `redirect: "error"`.
2. No name or title for a figure: staff are named only "Nurse", "Charge nurse", "Physician".
3. Nothing is stored: no browser storage and no cookie. `cache: "no-store"`. Checked by a source scan of `src/open-view.ts` and `src/App.tsx` only.
4. No control without a token: the top bar has no speed button or Reset (the speed shows as text, read-only), the side panel has no buttons, and `/live` is not read.
5. No other API call without a token.
6. No string from the answer reaches markup. Bed labels must match `[A-Za-z0-9][A-Za-z0-9 ._-]{0,19}` and are only matched against the map's `BEDS`.
7. Unknown keys are ignored and never read.
8. Poll every 2 s, not faster: the next request is scheduled 2 s after the last answer or failure, one at a time.
9. No logging of the answer.

Tests are in `src/open-view.test.ts` and `src/open-view.draw.test.ts`. The guards inside `src/App.tsx` (rules 4 and 5, click, hover, select list) are checked by scans of its source, not by mounting the page.

## Limits of the body

At most 64 KiB, read with a byte count, and a 5 s timeout. `clockS` at most 1e9. At most 100 beds, 20 staff and 20 moves. `ward` must equal `W4`. Any field out of shape, any unknown enum value, any number not finite or out of range refuses the whole body.

## Limits

- Synthetic data only. The route serves a synthetic run only.
- The API route may not exist yet, or may be off. Then the page is as before: the sign-in form.
