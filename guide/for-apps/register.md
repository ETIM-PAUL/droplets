# Register your app

Every app registers once. This gives you an app key, and ties your payments to your payout addresses so Droplets can verify them.

## Sign up

On the Droplets home page, go to **For apps** and choose **Register your app**. Fill in:

| Field | Notes |
|---|---|
| **App name** | Up to 40 letters, digits, spaces or `. ' & ! + -`, with no commas. It's how users pick your app, so use the name they know. Names are unique. |
| **Link** | Optional. Your website or Mini App address, `https://` only. It's shown in the list of apps. |
| **How we can reach you** | An email address or Telegram handle. It's only for the review and is never shown. |
| **Payout addresses** | Up to 5 Nimiq addresses your app pays from, one per line. |

You get your **app key** straight away, once. Copy it into your server's environment and keep it secret. We can't show it again; if you lose it, ask us for a new one and the old one stops working.

## Approval

The Droplets team reviews each new app. **Until it's approved, your key doesn't work**, and your app isn't in the list of apps users can pick from. That's what stops anyone from signing up just to try save codes and find out whose address belongs to a Droplets user. You'll be contacted using the details you gave.

Once approved, your key starts working and your app appears in users' saving rules.

## Payout addresses

Droplets only records payments sent from the addresses you registered. A payment from any other address is refused, so keep the list up to date: ask the team to change it if you change your payout wallet.

## Limits

- A handful of sign-ups an hour from one place.
- Your key may make up to 600 requests a minute, far more than a normal app needs.
