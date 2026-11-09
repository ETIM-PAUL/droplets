/** What Errand does with people's money, in plain words. Opened from Profile, under its own app bar. */
export function Help() {
  return (
    <div className="help">
      <section className="section">
        <h2 className="section-title">Your savings</h2>
        <div className="group">
          <div className="help-row">
            <strong>They stay in your own account</strong>
            <p>Your savings are NIM staked from your own Nimiq account, with a validator Errand suggests or one you choose. They earn staking rewards, and only you can move them: every change opens Nimiq Pay's own approval window.</p>
          </div>
          <div className="help-row">
            <strong>Taking money out</strong>
            <p>Withdrawing takes 12 to 24 hours, because Nimiq releases staked NIM at the end of an epoch. Then you finish it on Home, with two approvals in Nimiq Pay.</p>
          </div>
        </div>
      </section>

      <section className="section">
        <h2 className="section-title">Saving automatically</h2>
        <div className="group">
          <div className="help-row">
            <strong>Your save code</strong>
            <p>Give your code to apps that pay you NIM, like games, bounties and shops. Each time one pays you, your share goes into savings and the rest to your wallet. You can change your share or turn the code off any time, and signing is free.</p>
          </div>
          <div className="help-row">
            <strong>Apps that know it's you</strong>
            <p>Most apps get your address from Nimiq Pay, so there's nowhere to give a code. In your saving rules, pick the apps you use: they recognise the address they already pay and save for you. Apps you didn't pick can't tell you use Errand.</p>
          </div>
          <div className="help-row">
            <strong>Saving when you pay</strong>
            <p>Choose a share, like 5%, and apps you picked add it on top when you buy something, then put it into savings. You see the full amount before you approve it in Nimiq Pay. Paying anyone else stays as it is.</p>
          </div>
          <div className="help-row">
            <strong>The catch-up</strong>
            <p>For everything else you pay, Errand adds up your share each day, week, two weeks or month, as you choose, and shows it on Home with a Save button. Nothing can take it from your wallet by itself: you approve it in Nimiq Pay. If you add at least that much to your savings yourself, it counts too.</p>
          </div>
        </div>
      </section>

      <section className="section">
        <h2 className="section-title">Extras</h2>
        <div className="group">
          <div className="help-row">
            <strong>The weekly draw</strong>
            <p>Join it on the Draw tab. If you keep the minimum saved on enough days of the week, you're in that Sunday's draw, and keeping more gives you more tickets. The winner is picked with a Nimiq block made after the draw time, so nobody can know it in advance, and you never risk any of your savings.</p>
          </div>
          <div className="help-row">
            <strong>Ask Errand</strong>
            <p>Type things like "Save 30% of what apps pay me" or "When can I get my money?". Errand answers questions from your own savings. For a change, it shows the exact values with a Confirm button, and Nimiq Pay then asks you to approve it. If anything is unclear, it opens the form instead, filled in.</p>
          </div>
        </div>
      </section>
    </div>
  );
}
