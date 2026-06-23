"use client";

import { useState } from "react";

type Levers = {
  leads: number;
  mspend: number;
  book: number;
  close: number;
  ticket: number;
  dep: number;
  cap: number;
  gm: number;
};

const DEFAULTS: Levers = {
  leads: 80,
  mspend: 12100,
  book: 22.5,
  close: 38.9,
  ticket: 11500,
  dep: 50,
  cap: 7,
  gm: 50,
};

const money = (n: number) => {
  const neg = n < 0;
  const s = Math.round(Math.abs(n)).toLocaleString("en-US");
  return (neg ? "-$" : "$") + s;
};
const n1 = (n: number) =>
  (Math.round(n * 10) / 10).toLocaleString("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
const whole = (n: number) => Math.round(n).toLocaleString("en-US");

function Slider({
  label,
  id,
  min,
  max,
  step,
  value,
  display,
  onChange,
}: {
  label: string;
  id: string;
  min: number;
  max: number;
  step: number;
  value: number;
  display: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="ctl">
      <label htmlFor={id}>{label}</label>
      <div className="row">
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value))}
        />
        <output>{display}</output>
      </div>
    </div>
  );
}

export function OperatingModel() {
  const [v, setV] = useState<Levers>(DEFAULTS);
  const [period, setPeriod] = useState(1);
  const set = (k: keyof Levers) => (val: number) => setV((s) => ({ ...s, [k]: val }));

  const leads = v.leads;
  const appts = leads * (v.book / 100);
  const sold = appts * (v.close / 100);
  const done = Math.min(v.cap, sold);
  const soldRev = sold * v.ticket;
  const doneRev = done * v.ticket;
  const depIn = sold * v.ticket * (v.dep / 100);
  const finIn = done * v.ticket * (1 - v.dep / 100);
  const cashIn = depIn + finIn;
  const gp = doneRev * (v.gm / 100);
  const cpl = v.mspend / leads;
  const cac = sold > 0 ? v.mspend / sold : 0;
  const conv3 = sold > 0 ? Math.round((done / sold) * 100) : 0;

  const diff = sold - v.cap;
  let verdict: { color: string; badge: string; text: React.ReactNode };
  if (diff > 0.05) {
    verdict = {
      color: "var(--lv-crimson)",
      badge: "Installs behind sales",
      text: (
        <>
          Sales is writing <b className="navy">{n1(sold)}</b> jobs a day but crews can
          finish <b className="navy">{whole(v.cap)}</b>. Backlog grows by{" "}
          <b className="navy">{n1(diff)}</b> jobs a day, about {n1(diff * 5)} a week. Add
          install capacity or pace sales to the crews.
        </>
      ),
    };
  } else if (diff < -0.05) {
    verdict = {
      color: "var(--lv-green)",
      badge: "Capacity to spare",
      text: (
        <>
          Crews can finish <b className="navy">{whole(v.cap)}</b> a day and sales is
          writing <b className="navy">{n1(sold)}</b>. That is{" "}
          <b className="navy">{n1(-diff)}</b> jobs a day of headroom to burn down backlog
          or take on more volume.
        </>
      ),
    };
  } else {
    verdict = {
      color: "var(--lv-navy)",
      badge: "In balance",
      text: (
        <>
          Crews finish exactly what sales writes, <b className="navy">{n1(sold)}</b> jobs a
          day. The cycle is closed and the day clears clean.
        </>
      ),
    };
  }

  return (
    <div className="levers-tool">
      <style>{CSS}</style>

      <h2>Set the Levers</h2>
      <div className="panel">
        <div className="grp">
          <h3>Pillar 1 · Marketing gets the leads</h3>
          <div className="controls">
            <Slider label="Leads per day" id="leads" min={40} max={140} step={5} value={v.leads} display={`${whole(v.leads)} / day`} onChange={set("leads")} />
            <Slider label="Marketing spend per day" id="mspend" min={4000} max={20000} step={100} value={v.mspend} display={money(v.mspend)} onChange={set("mspend")} />
          </div>
        </div>
        <div className="grp">
          <h3>Pillar 2 · Front office books the lead</h3>
          <div className="controls">
            <Slider label="Booking rate (lead to run appointment)" id="book" min={12} max={40} step={0.5} value={v.book} display={`${v.book}%`} onChange={set("book")} />
          </div>
        </div>
        <div className="grp">
          <h3>Pillar 3 · Sales closes the lead</h3>
          <div className="controls">
            <Slider label="Close rate (appointment to sold)" id="close" min={25} max={55} step={0.5} value={v.close} display={`${v.close}%`} onChange={set("close")} />
            <Slider label="Average ticket" id="ticket" min={6000} max={16000} step={250} value={v.ticket} display={money(v.ticket)} onChange={set("ticket")} />
            <Slider label="Deposit collected at sale" id="dep" min={25} max={60} step={5} value={v.dep} display={`${v.dep}%`} onChange={set("dep")} />
          </div>
        </div>
        <div className="grp">
          <h3>Pillar 4 · Installs completes the sale</h3>
          <div className="controls">
            <Slider label="Install capacity (jobs per day)" id="cap" min={3} max={14} step={1} value={v.cap} display={`${whole(v.cap)} / day`} onChange={set("cap")} />
            <Slider label="Gross margin on completed work" id="gm" min={38} max={58} step={1} value={v.gm} display={`${v.gm}%`} onChange={set("gm")} />
          </div>
        </div>
      </div>

      <h2>The 4-Pillar Scoreboard (per day)</h2>
      <div className="grid cards4">
        <div className="pillar">
          <div className="tag">Pillar 1</div><div className="who">Marketing</div>
          <div className="val">{whole(leads)}</div><div className="unit">leads generated</div>
          <ul>
            <li><span>Spend</span><span>{money(v.mspend)}</span></li>
            <li><span>Cost per lead</span><span>{money(cpl)}</span></li>
          </ul>
        </div>
        <div className="pillar">
          <div className="tag">Pillar 2</div><div className="who">Front Office</div>
          <div className="val">{n1(appts)}</div><div className="unit">appointments run</div>
          <ul>
            <li><span>Booking rate</span><span>{v.book}%</span></li>
            <li><span>Of leads</span><span>{whole(leads)}</span></li>
          </ul>
        </div>
        <div className="pillar">
          <div className="tag">Pillar 3</div><div className="who">Sales</div>
          <div className="val">{n1(sold)}</div><div className="unit">jobs sold</div>
          <ul>
            <li><span>Close rate</span><span>{v.close}%</span></li>
            <li><span>Sold value</span><span>{money(soldRev)}</span></li>
            <li><span>Cost per sold job</span><span>{money(cac)}</span></li>
          </ul>
        </div>
        <div className="pillar">
          <div className="tag">Pillar 4</div><div className="who">Installs</div>
          <div className="val">{n1(done)}</div><div className="unit">jobs completed</div>
          <ul>
            <li><span>Capacity</span><span>{whole(v.cap)} / day</span></li>
            <li><span>Completed value</span><span>{money(doneRev)}</span></li>
            <li><span>Cash collected</span><span>{money(cashIn)}</span></li>
          </ul>
        </div>
      </div>

      <h2>The Flow</h2>
      <div className="flow">
        <div className="node"><div className="n">{whole(leads)}</div><div className="t">Leads</div></div>
        <div className="conv">{v.book}%</div>
        <div className="node"><div className="n">{n1(appts)}</div><div className="t">Run Appts</div></div>
        <div className="conv">{v.close}%</div>
        <div className="node sold"><div className="n">{n1(sold)}</div><div className="t">Sold</div></div>
        <div className="conv">{conv3}%</div>
        <div className="node"><div className="n">{n1(done)}</div><div className="t">Installed</div></div>
      </div>

      <h2>Daily Production &amp; Cash</h2>
      <div className="seg">
        {[
          { p: 1, label: "Per day" },
          { p: 21, label: "Per month" },
          { p: 252, label: "Per year" },
        ].map((o) => (
          <button key={o.p} className={period === o.p ? "on" : ""} onClick={() => setPeriod(o.p)}>
            {o.label}
          </button>
        ))}
      </div>
      <div className="panel">
        <table>
          <tbody>
            <tr><td>Jobs sold</td><td className="num">{n1(sold * period)}</td></tr>
            <tr><td>Jobs completed</td><td className="num">{n1(done * period)}</td></tr>
            <tr><td>Sold value</td><td className="num">{money(soldRev * period)}</td></tr>
            <tr><td>Completed value</td><td className="num">{money(doneRev * period)}</td></tr>
            <tr><td>Deposits collected at sale</td><td className="num">{money(depIn * period)}</td></tr>
            <tr><td>Final payments at completion</td><td className="num">{money(finIn * period)}</td></tr>
            <tr className="tot"><td>Total cash collected</td><td className="num">{money(cashIn * period)}</td></tr>
            <tr className="tot"><td>Gross profit on completed work</td><td className="num">{money(gp * period)}</td></tr>
          </tbody>
        </table>
      </div>

      <h2>Install Balance</h2>
      <div className="verdict" style={{ borderColor: verdict.color }}>
        <span className="badge" style={{ background: verdict.color }}>{verdict.badge}</span>
        <p>{verdict.text}</p>
      </div>

      <p className="foot">
        Planning model for operations. Booking and close rates start at Floor Daddy&apos;s
        stated 22.5% and 38.9%. Tune every lever to your real numbers and the whole day
        reflows.
      </p>
    </div>
  );
}

const CSS = `
.levers-tool{--lv-navy:#16335B;--lv-navy-deep:#11294A;--lv-crimson:#9E2335;--lv-stone:#C8C1B6;--lv-ink:#1c2330;--lv-green:#2E7D55;--lv-display:"Oswald","Arial Black",Arial,sans-serif;--lv-body:"Spectral",Georgia,serif;color:var(--lv-ink);font-family:var(--lv-body);line-height:1.5}
.levers-tool h2{font-family:var(--lv-display);font-weight:600;color:var(--lv-navy);letter-spacing:.02em;font-size:18px;text-transform:uppercase;margin:26px 0 10px;border-left:4px solid var(--lv-crimson);padding-left:10px}
.levers-tool .grid{display:grid;gap:12px}
.levers-tool .cards4{grid-template-columns:repeat(4,1fr)}
@media(max-width:820px){.levers-tool .cards4{grid-template-columns:1fr 1fr}}
@media(max-width:520px){.levers-tool .cards4{grid-template-columns:1fr}}
.levers-tool .pillar{background:#fff;border:1px solid var(--lv-stone);border-radius:10px;padding:14px;border-top:5px solid var(--lv-navy)}
.levers-tool .pillar .tag{font-family:var(--lv-display);text-transform:uppercase;letter-spacing:.08em;font-size:10.5px;color:var(--lv-crimson);font-weight:600}
.levers-tool .pillar .who{font-family:var(--lv-display);text-transform:uppercase;letter-spacing:.04em;font-size:12.5px;color:#5b6678;font-weight:600;margin-top:1px}
.levers-tool .pillar .val{font-family:var(--lv-display);font-weight:700;font-size:34px;color:var(--lv-navy);margin:6px 0 0;line-height:1}
.levers-tool .pillar .unit{font-size:12px;color:#5b6678;font-weight:400}
.levers-tool .pillar ul{list-style:none;margin:8px 0 0;padding:0}
.levers-tool .pillar li{font-size:12.5px;color:#3a4456;display:flex;justify-content:space-between;padding:2px 0;border-top:1px dashed #e7e1d6}
.levers-tool .pillar li span:last-child{font-variant-numeric:tabular-nums;font-weight:600;color:var(--lv-navy)}
.levers-tool .panel{background:#fff;border:1px solid var(--lv-stone);border-radius:12px;padding:16px}
.levers-tool .grp{margin-bottom:16px}
.levers-tool .grp:last-child{margin-bottom:0}
.levers-tool .grp h3{font-family:var(--lv-display);text-transform:uppercase;letter-spacing:.06em;font-size:12px;color:var(--lv-crimson);margin:0 0 8px;font-weight:600}
.levers-tool .controls{display:grid;grid-template-columns:1fr 1fr;gap:12px 22px}
@media(max-width:640px){.levers-tool .controls{grid-template-columns:1fr}}
.levers-tool .ctl label{display:block;font-family:var(--lv-display);text-transform:uppercase;letter-spacing:.04em;font-size:11px;color:var(--lv-navy);font-weight:600;margin-bottom:2px}
.levers-tool .ctl .row{display:flex;align-items:center;gap:10px}
.levers-tool input[type=range]{flex:1;accent-color:var(--lv-crimson)}
.levers-tool .ctl output{font-family:var(--lv-display);font-weight:700;color:var(--lv-crimson);min-width:84px;text-align:right;font-size:15px}
.levers-tool table{width:100%;border-collapse:collapse;font-size:14.5px}
.levers-tool th,.levers-tool td{text-align:left;padding:9px 10px;border-bottom:1px solid #e7e1d6}
.levers-tool td.num,.levers-tool th.num{text-align:right;font-variant-numeric:tabular-nums}
.levers-tool tr.tot td{border-top:2px solid var(--lv-navy);font-weight:700;color:var(--lv-navy);border-bottom:none}
.levers-tool .verdict{display:flex;align-items:center;gap:12px;border-radius:12px;padding:14px 16px;border:2px solid}
.levers-tool .verdict .badge{font-family:var(--lv-display);font-weight:700;text-transform:uppercase;letter-spacing:.04em;font-size:14px;padding:6px 12px;border-radius:999px;color:#fff;white-space:nowrap}
.levers-tool .verdict p{margin:0;font-size:14px}
.levers-tool .seg{display:inline-flex;border:1px solid var(--lv-navy);border-radius:999px;overflow:hidden;margin-bottom:10px}
.levers-tool .seg button{font-family:var(--lv-display);text-transform:uppercase;letter-spacing:.05em;font-size:12px;font-weight:600;border:none;background:#fff;color:var(--lv-navy);padding:7px 16px;cursor:pointer}
.levers-tool .seg button.on{background:var(--lv-navy);color:#fff}
.levers-tool .flow{display:flex;align-items:stretch;gap:0;flex-wrap:wrap;margin-top:2px}
.levers-tool .flow .node{flex:1;min-width:120px;text-align:center;background:var(--lv-navy);color:#fff;border-radius:10px;padding:10px 8px}
.levers-tool .flow .node.sold{background:var(--lv-crimson)}
.levers-tool .flow .node .n{font-family:var(--lv-display);font-weight:700;font-size:26px;line-height:1}
.levers-tool .flow .node .t{font-family:var(--lv-display);text-transform:uppercase;font-size:10.5px;letter-spacing:.05em;margin-top:3px;color:#cdd6e6}
.levers-tool .flow .conv{display:flex;align-items:center;justify-content:center;font-family:var(--lv-display);font-weight:700;color:var(--lv-crimson);font-size:13px;padding:0 8px;min-width:54px}
@media(max-width:640px){.levers-tool .flow .conv{width:100%;padding:4px 0}}
.levers-tool .foot{font-size:12.5px;color:#5b6678;margin-top:10px}
.levers-tool b.navy{color:var(--lv-navy)}
`;
