/** What Droplets does with people's money, in plain words. Opened from Profile, under its own app bar. */
export function Help() {
  return (
    <div className="help">
      <section className="section">
        <h2 className="section-title">Your savings</h2>
        <div className="group">
          <div className="help-row">
            <strong>They stay in your own account</strong>
            <p>Staked from your own Nimiq account, earning rewards. Only you can move them: every change needs your approval in Nimiq Pay.</p>
          </div>
          <div className="help-row">
            <strong>Taking money out</strong>
            <p>Takes 12 to 24 hours. Then two approvals in Nimiq Pay finish it on Home.</p>
          </div>
          <div className="help-row">
            <strong>Goals</strong>
            <p>Name part of your savings and set a target, and a date if you like. Drops fill goals in order. A dated goal can't be withdrawn early: breaking it costs 10% of what's in it, paid to Droplets, then a 24-hour wait for the rest. Withdrawing from a locked goal outside Droplets bars new goals for a week.</p>
          </div>
        </div>
      </section>

      <section className="section">
        <h2 className="section-title">Saving automatically</h2>
        <div className="group">
          <div className="help-row">
            <strong>Your save code</strong>
            <p>Give it to apps that pay you NIM. Each time, your share goes into savings and the rest to your wallet. Change your share or turn it off any time.</p>
          </div>
          <div className="help-row">
            <strong>Apps that know it's you</strong>
            <p>Most apps already have your address. Pick the ones you use in your saving rules and they save for you, no code needed. Apps you didn't pick can't tell you use Droplets.</p>
          </div>
          <div className="help-row">
            <strong>Saving when you pay</strong>
            <p>Choose a share like 5%. Apps you picked add it on top when you buy, then put it into savings. You see the full amount before approving.</p>
          </div>
          <div className="help-row">
            <strong>The catch-up</strong>
            <p>For other payments, Droplets totals your share each day, week or month and shows a Save button on Home. You approve it in Nimiq Pay. Saving that much yourself counts too.</p>
          </div>
        </div>
      </section>

      <section className="section">
        <h2 className="section-title">Extras</h2>
        <div className="group">
          <div className="help-row">
            <strong>The weekly draw</strong>
            <p>Join on the Draw tab. Keep the minimum saved on enough days and you're in Sunday's draw; saving more means more tickets. A Nimiq block picks the winner, and your savings are never at risk.</p>
          </div>
          <div className="help-row">
            <strong>Ask Droplets</strong>
            <p>Type "Save 30% of what apps pay me" or "When can I get my money?". Changes show exact values with a Confirm button, then Nimiq Pay asks you to approve.</p>
          </div>
        </div>
      </section>
    </div>
  );
}
