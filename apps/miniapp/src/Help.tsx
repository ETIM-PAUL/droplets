import { ReportProblem } from "./ReportProblem";

/** What Errand does with people's money, in plain words. */
export function Help() {
  return (
    <>
      <header className="home-head"><h1>Help</h1></header>
      <div className="group">
        <div className="help-row">
          <strong>Grow keeps your savings in your own account</strong>
          <p>Grow is NIM you stake from your own Nimiq account, with a validator you pick. It earns staking rewards, and only you can move it: every change opens Nimiq Pay's own approval window.</p>
        </div>
        <div className="help-row">
          <strong>Your save code</strong>
          <p>Give your code to apps that pay you NIM, like games, bounties and shops. Each time one pays you, your share goes into Grow and the rest to your wallet. You can change your share or turn the code off any time, and signing costs nothing.</p>
        </div>
        <div className="help-row">
          <strong>Taking money out</strong>
          <p>Withdrawing from Grow takes 12 to 24 hours, because Nimiq releases staked NIM at the end of an epoch. Then you finish it in Savings, with two approvals in Nimiq Pay.</p>
        </div>
        <div className="help-row">
          <strong>The weekly draw</strong>
          <p>Join it on Savings. If you keep the minimum in Grow on enough days of the week, you're in that Sunday's draw, and keeping more gives you more tickets. The card on Savings shows the minimum, the days and the prize. The winner is picked with a Nimiq block made after the draw time, so nobody can know it in advance, and you never risk any of your savings.</p>
        </div>
        <div className="help-row">
          <strong>Ask Errand</strong>
          <p>Type things like "Save 30% of what apps pay me" or "When can I get my money?". Errand answers, or opens the right screen with your request filled in. Nothing moves until you approve it in Nimiq Pay.</p>
        </div>
      </div>
      <section className="section">
        <h2 className="section-title">Something went wrong?</h2>
        <ReportProblem />
      </section>
    </>
  );
}
