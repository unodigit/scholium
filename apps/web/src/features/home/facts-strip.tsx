import { Icon } from "./icons";
import "./home.css";

export function FactsStrip() {
  return (
    <section className="facts" aria-label="Scholium at a glance">
      <ul className="wrap facts-row">
        <li><Icon name="gift" /><span><b>Free</b> to read and to publish</span></li>
        <li><Icon name="cc" /><span><b>CC BY 4.0</b> by default</span></li>
        <li><Icon name="ban" /><span><b>No token.</b> No paywall.</span></li>
        <li><Icon name="shield" /><span><b>Verifies offline,</b> without us</span></li>
      </ul>
    </section>
  );
}

export default FactsStrip;
