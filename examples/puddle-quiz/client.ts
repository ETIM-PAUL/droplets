// The page's script: asks for a save code, deals the questions, sends the answers.

interface Quiz {
  app: string;
  network: string;
  rewardNim: string;
  pass: number;
  codeOnly: boolean;
  withDroplets: boolean;
}
interface Result {
  score: number;
  paid: boolean;
  message?: string;
  rewardNim?: string;
  walletNim?: string;
  growNim?: string;
  reason?: string | null;
  walletTx?: string | null;
  growTx?: string | null;
  repeated?: boolean;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const answers: number[] = [];

const REASONS: Record<string, string> = {
  "no-stake": "Your Grow is closed, so the whole reward went to your wallet.",
  "validator-gone": "The validator you saved with has left, so the whole reward went to your wallet.",
  "below-minimum": "Saving this would leave your stake under Nimiq's 100 NIM minimum, so the whole reward went to your wallet.",
};

function show(r: Result) {
  const out = $("result");
  out.hidden = false;
  out.className = "result" + (r.paid ? " ok" : "");
  if (!r.paid) {
    out.textContent = r.message ?? "Try again.";
    return;
  }
  const saved = r.growNim !== "0";
  const total = Number(r.rewardNim);
  const growShare = saved ? Math.max(4, Math.round((Number(r.growNim) / total) * 100)) : 0;
  out.innerHTML = `
    <p class="big">${r.repeated ? "You already won today" : "You won"} ${r.rewardNim} NIM</p>
    <div class="split" role="img" aria-label="${r.walletNim} NIM to your wallet, ${r.growNim} NIM to your savings">
      <span class="wallet" style="flex:${100 - growShare}"></span>${saved ? `<span class="grow" style="flex:${growShare}"></span>` : ""}
    </div>
    <p><b>${r.walletNim} NIM</b> to your wallet${saved ? `, <b>${r.growNim} NIM</b> into your savings with Droplets` : ""}.</p>
    ${r.reason ? `<p class="hint">${REASONS[r.reason] ?? ""}</p>` : ""}
    ${!saved && !r.reason ? `<p class="hint">Want part of rewards saved? In Droplets, allow ${$("app").textContent} in your saving rule.</p>` : ""}
    <p class="hint tx">${[r.walletTx, r.growTx].filter(Boolean).map((h) => `<code>${h!.slice(0, 10)}…</code>`).join(" ")}</p>`;
}

let quizId = "";

function problem(message: string) {
  const out = $("result");
  out.hidden = false;
  out.className = "result bad";
  out.textContent = message;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? "Something went wrong.");
  return data;
}

function ask(questions: { q: string; options: string[] }[]) {
  const form = $("questions");
  form.replaceChildren();
  answers.length = questions.length;
  answers.fill(-1);
  questions.forEach((q, i) => {
    const set = document.createElement("fieldset");
    const legend = document.createElement("legend");
    legend.textContent = q.q;
    set.append(legend);
    q.options.forEach((o, j) => {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "radio";
      input.name = `q${i}`;
      input.addEventListener("change", () => (answers[i] = j));
      label.append(input, ` ${o}`);
      set.append(label);
    });
    form.append(set);
  });
  $("step-code").hidden = true;
  $("step-quiz").hidden = false;
}

/** Step 1: the save code. Droplets confirms it's a real account before any questions are dealt. */
async function begin() {
  const button = $<HTMLButtonElement>("begin");
  button.disabled = true;
  $("result").hidden = true;
  try {
    const r = await post<{ quizId?: string; questions?: { q: string; options: string[] }[]; done?: Result }>("/api/start", { to: $<HTMLInputElement>("to").value });
    if (r.done) return show(r.done);
    quizId = r.quizId!;
    ask(r.questions!);
  } catch (e) {
    problem((e as Error).message);
  } finally {
    button.disabled = false;
  }
}

/** Step 2: the answers. */
async function claim() {
  const button = $<HTMLButtonElement>("claim");
  if (answers.includes(-1)) return problem("Answer every question first.");
  button.disabled = true;
  button.textContent = "Sending…";
  try {
    const r = await post<Result>("/api/claim", { quizId, answers });
    show(r);
    if (r.paid || !r.paid) {
      $("step-quiz").hidden = true;
      $("step-code").hidden = false;
    }
  } catch (e) {
    problem((e as Error).message);
  } finally {
    button.disabled = false;
    button.textContent = "Claim my reward";
  }
}

async function startPage() {
  const quiz = (await (await fetch("/api/quiz")).json()) as Quiz;
  $("app").textContent = quiz.app;
  document.title = quiz.app;
  $("reward").textContent = `${quiz.rewardNim} NIM`;
  $("net").hidden = quiz.network === "main";
  $("plain").hidden = quiz.withDroplets;
  $<HTMLInputElement>("to").placeholder = quiz.codeOnly ? "SAVE-7KQ2XMP" : "NQ.. .... or SAVE-7KQ2XMP";
  $("code-only").hidden = !quiz.codeOnly;
  $("any").hidden = quiz.codeOnly;
  $("begin").addEventListener("click", begin);
  $("claim").addEventListener("click", claim);
}
void startPage();
