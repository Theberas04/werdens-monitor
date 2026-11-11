'use strict';
// Slack-meldingen via een inkomende webhook. Geen npm-pakket, geen bot-token:
// één URL uit Slack (App → Incoming Webhooks) is genoeg. De aanroeper bepaalt
// wanneer er iets verstuurd wordt; dit bestand zorgt alleen voor het formatteren
// en het versturen met een korte time-out, zodat een trage Slack nooit de
// monitor ophoudt.

const TIMEOUT_MS = Number(process.env.SLACK_TIMEOUT_MS) || 8000;

// Slack-webhooks hebben een vaste vorm. In tests mag een lokaal adres, zodat we
// geen echte Slack nodig hebben; dat kan alleen als WM_SLACK_TEST=1 staat.
const SLACK_WEBHOOK = /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+$/;
const LOKAAL_WEBHOOK = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/[A-Za-z0-9/_.-]*$/;

function testToegestaan() {
  return process.env.WM_SLACK_TEST === '1';
}

function controleerWebhook(waarde) {
  const s = String(waarde || '').trim();
  if (!s) throw new Error('Slack-webhook-URL is leeg');
  if (SLACK_WEBHOOK.test(s)) return s;
  if (testToegestaan() && LOKAAL_WEBHOOK.test(s)) return s;
  throw new Error('Dit is geen Slack-webhook. Hij begint met https://hooks.slack.com/services/');
}

const SOORT_KLEUR = {
  'host neer': '#dc2626',
  'site neer': '#dc2626',
  'certificaat': '#b45309',
  'schijf vol': '#b45309',
  'poort open': '#2ea3f2',
  herstel: '#059669',
};

const EMOJI = {
  'host neer': ':red_circle:',
  'site neer': ':red_circle:',
  certificaat: ':warning:',
  'schijf vol': ':warning:',
  'poort open': ':large_blue_circle:',
  herstel: ':white_check_mark:',
};

const regel = (v, max = 280) => String(v === undefined || v === null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);

// Kort bericht voor in de melding zelf; `tekst` blijft de terugvaloptie voor
// clients die blokken niet tekenen (en voor pushmeldingen op de telefoon).
function berichtVoorAlert(alert, extra = {}) {
  const soort = regel(alert.soort, 40) || 'melding';
  const host = regel(alert.naam || alert.hostnaam || alert.ip, 80);
  const ip = regel(alert.ip, 60);
  const titel = host && host !== ip ? host + ' (' + ip + ')' : ip;
  const kleur = SOORT_KLEUR[soort] || '#2ea3f2';
  const emoji = EMOJI[soort] || ':information_source:';
  const tijd = alert.op ? new Date(alert.op).toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' }) : '';
  const regels = [
    emoji + ' *' + regel(alert.bericht, 200) + '*',
    titel ? 'Host: `' + titel + '`' : '',
    extra.site ? 'Site: ' + regel(extra.site, 120) : '',
    tijd ? 'Gemeten: ' + tijd : '',
  ].filter(Boolean);
  return {
    tekst: regel(soort + ': ' + (titel ? titel + ' — ' : '') + regel(alert.bericht, 200), 300),
    blokken: [
      { type: 'section', text: { type: 'mrkdwn', text: regels.join('\n') } },
      ...(extra.basis ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: 'Werdens Monitor · <' + extra.basis + '|dashboard openen>' }] }] : []),
    ],
    bijlagen: [{ color: kleur, fallback: regel(alert.bericht, 200) }],
  };
}

async function stuur(webhook, bericht) {
  const url = controleerWebhook(webhook);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: bericht.tekst,
        blocks: bericht.blokken,
        unfurl_links: false,
        unfurl_media: false,
      }),
      signal: controller.signal,
    });
    const tekstUit = await r.text().catch(() => '');
    if (!r.ok) {
      const reden = tekstUit === 'invalid_token' || /invalid_token/.test(tekstUit)
        ? 'de webhook is ingetrokken of verkeerd gekopieerd'
        : 'Slack antwoordde met ' + r.status;
      throw new Error(reden);
    }
    return { ok: true, status: r.status };
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Slack reageerde niet binnen ' + Math.round(TIMEOUT_MS / 1000) + ' seconden');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Stuurt nooit een throw door naar de meetronde: een kapotte webhook mag het
// dashboard niet platleggen. De fout wordt wel teruggegeven zodat de UI hem kan tonen.
async function meldAlert(webhook, alert, extra = {}) {
  try {
    await stuur(webhook, berichtVoorAlert(alert, extra));
    return { ok: true };
  } catch (e) {
    return { ok: false, fout: e.message };
  }
}

module.exports = { controleerWebhook, berichtVoorAlert, stuur, meldAlert };
