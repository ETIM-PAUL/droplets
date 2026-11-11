# Is it safe?

## Your savings

- **They stay in your own account.** Savings are staked from your own Nimiq account. Droplets has no wallet that holds your NIM, and nobody at Droplets can move it.
- **You approve everything.** Every deposit, withdrawal and rule change opens Nimiq Pay's own approval window. Droplets can't sign for you.
- **Nimiq has no slashing.** Staked NIM isn't cut when a validator misbehaves. If your validator closes, move your stake to another one in Nimiq Pay.

## Your rules

Your rules are a message you sign with your own key. The server checks the signature, that the message is under 10 minutes old, and that it hasn't been used before, so a rule can't be forged or replayed.

## Apps

- **Apps never touch your savings.** An app pays you NIM and adds to your stake; adding is all it can do.
- **When you pay an app, it handles the saved part for a moment.** With a share on top, you pay the app the price plus your share, and the app then sends your share into your stake. The app is meant to send it on and Droplets only approves apps it has reviewed, but nothing on the Nimiq chain forces it. If the saved part never shows in **Activity**, report the app with **Report a problem** on Profile.
- **Apps can't find out who uses Droplets.** An app you didn't allow gets the same answer as for a non-user.
- **Every app is reviewed.** Apps register with Droplets and the team approves them before they can look anyone up.
- **Receipts are checked on-chain.** A payment only shows in your history if the Nimiq chain confirms it was sent from the app's registered address.

## Costs and risks

Droplets takes no fee or cut on your savings or on withdrawing them. The only charge is for breaking a dated goal early: 10% of what's in it, paid to Droplets, with the rest free after a 24-hour wait. Withdrawing from a locked goal directly in Nimiq Pay, bypassing Droplets, bars creating a new goal for 30 days. Staking rewards depend on the validator, and withdrawals take 12 to 24 hours. Droplets is new software: keep in savings only what you're comfortable with, and start small.
