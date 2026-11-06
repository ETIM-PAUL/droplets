import { ReportProblem } from "./ReportProblem";

/** What Errand does with people's money, in plain words. */
export function Help({ pool }: { pool: boolean }) {
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
        {pool && (
          <div className="help-row">
            <strong>Steady and Boost</strong>
            <p>Steady keeps its dollar value. Boost takes NIM's ups and downs for both sides, about twice as much when both sides are the same size. Unlike Grow, Errand holds the NIM in this pool. The reserves check shows what the pool holds against what it owes.</p>
          </div>
        )}
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
