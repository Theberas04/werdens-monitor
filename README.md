# Werdens Monitor

Eigen infra- en websitedashboard voor Werdens Media. Geen fork van Checkmk en
geen Checkmk-code: de *functies* zijn nagemaakt in een eigen stack — één
Node-proces, de ingebouwde `node:sqlite`, geen npm-afhankelijkheden, geen Docker,
en een Nederlandse mobiel-eerste interface die als PWA te installeren is.

![Overzicht van Werdens Monitor](docs/img/overzicht-desktop.png)

## Wat het doet

**Overzicht** — alle websites, projecten en tickets in één beeld, met de laatste
meting, open tickets en de eerstvolgende controle.

**Projecten** — al je GitHub-repo's met zichtbaarheid, primaire taal, laatste
commit, CI-uitslag, open issues en de versie uit de tags (`v1.4.2` → `1.4.2`).

**Websites** — per site status, responstijd, HTTP-code, TLS-vervaldatum, de
versie uit de headers of de pagina, optioneel een stats-endpoint (bezoekers,
schijf, gebruikers) en de geschiedenis van de laatste 26 metingen.

**Tickets per IP-adres** — elk IP heeft een eigen ticketlijst. Je maakt een
ticket aan, de AI-agent van je ICT pikt het op via een eigen API met een eigen
token, schrijft zijn onderzoek terug in het ticket en zet de status. De agent
krijgt precies genoeg: het ticket, het gesprek, de laatste poortscan van dat IP
en de sites die erop draaien.

**Poortscan** — een IP aftasten op de gebruikelijke poorten meteen bij het
aanmaken van een ticket, zodat de agent weet wat er open staat.

## Welke Checkmk-functies zitten erin

Geen Checkmk-code, wel hetzelfde idee: hosts met diensten, toestanden, meldingen
en een gebeurtenissenlog. Wat hieronder "ja" staat is gebouwd en getest; "nee"
is bewust niet gedaan, met de reden erbij.

| Checkmk-functie | Hier | Toelichting |
|---|---|---|
| Hosts beheren | ja | eigen IP-lijst met naam, notitie, locatie en labels |
| Diensten per host | ja | poortscan → HTTP, TLS, SSH, database, Redis enz. met toestand |
| Status OK/WAARSCHUWING/KRITIEK/ONBEKEND | ja | per dienst en opgerold naar host en dashboard |
| Check-plugins (agentloos) | ja | HTTP(S), headers, TLS-vervaldatum, TCP-connect |
| Klassieke Checkmk-agent | nee | vergt een agent per host; de scan geeft dezelfde informatie zonder installatie |
| SNMP | nee | kan later met een eigen plugin; nu geen apparatuur in beheer |
| Meldingen (mail/SMS) | deels | storingen in dashboard en log; webhook naar Slack kan erbij |
| Onderhoudsvensters (downtime) | ja | per IP met eindtijd en reden; host wordt niet gescand of gemeld |
| Bevestigen (acknowledge) | ja | alert als bekend markeren met je naam |
| Gebeurtenissenlog | ja | alert, opgelost, onderhoud, configuratiewijziging, met tijd en IP |
| Beschikbaarheid / SLA | ja | uptime over 24 uur uit bewaarde controles |
| Grafieken / metriekhistorie | deels | responstijden bewaard per meting; nog geen grafiekweergave |
| Views en dashboards | ja | eigen dashboard met KPI's, storingen en recente gebeurtenissen |
| Meerdere locaties (distributed) | nee | één installatie; wel een locatielabel per host |
| Gebruikers en rollen | deels | één beheerder met sessie-cookie; geen rolbomen |
| Audit-log | ja | gebeurtenissenlog bewaart wie wat wijzigde |
| REST-API | ja | `/api/*` met sessie-cookie, plus agent-API met token |
| Certificaatbewaking | ja | dagen tot verval per site en per host-poort |
| Voorraad (hardware/software) | nee | buiten scope; wel versie per site en per GitHub-repo |
| BI / voorspellingen | nee | geen historiek lang genoeg op dagbasis |

## Schermen

| Overzicht | Projecten |
|---|---|
| ![](docs/img/overzicht-desktop.png) | ![](docs/img/projecten-desktop.png) |

| Websites | Tickets |
|---|---|
| ![](docs/img/websites-desktop.png) | ![](docs/img/tickets-desktop.png) |

| Instellingen | Mobiel |
|---|---|
| ![](docs/img/instellingen-desktop.png) | ![](docs/img/overzicht-mobiel.png) |

| IP-adressen | Hostdetail |
|---|---|
| ![](docs/img/hosts-desktop.png) | ![](docs/img/host-detail-desktop.png) |

Een rondleiding door de app: **[demo-video (42 s, 1440×900)](docs/video/werdens-monitor-demo.mp4)**.

## Installeren

Eén regel op de Proxmox-host (Debian/Ubuntu, Node 22.5 of nieuwer):

```bash
curl -fsSL https://raw.githubusercontent.com/Theberas04/werdens-monitor/main/deploy/installeer.sh | bash
```

Of met de hand:

```bash
git clone https://github.com/Theberas04/werdens-monitor.git /opt/werdens-monitor
cd /opt/werdens-monitor
ADMIN_PASSWORD='kies-er-een' GITHUB_TOKEN='ghp_...' PORT=8080 node server.js
```

De database staat in `data/monitor.db` en wordt bij de eerste start aangemaakt.
Zonder `ADMIN_PASSWORD` genereert de app er één en zet die in het log; zonder
`GITHUB_TOKEN` werkt de Projecten-tab niet (de GitHub-API is dan snel leeg).

| Variabele | Standaard | Betekenis |
|---|---|---|
| `PORT` | `8080` | poort waarop de app luistert |
| `DB_PATH` | `data/monitor.db` | pad naar de SQLite-database |
| `ADMIN_PASSWORD` | gegenereerd | wachtwoord van het beheerdersaccount |
| `ADMIN_NAAM` | `tom` | naam in de kop van het dashboard |
| `GITHUB_TOKEN` | — | token voor de Projecten-tab |
| `GITHUB_EIGENAAR` | `Theberas04` | wiens repo's getoond worden |
| `CHECK_TIMEOUT_MS` | `8000` | tijdslimiet per meting |

## De AI-agent koppelen

Zet in **Instellingen** een agent-token aan en geef dat aan je ICT-agent. Die
gebruikt alleen deze routes, met `Authorization: Bearer <token>`:

- `GET /api/agent/tickets?status=open` — openstaande tickets
- `GET /api/agent/tickets/:id` — ticket, gesprek, poortscan en sites op dat IP
- `POST /api/agent/tickets/:id/berichten` — onderzoek terugschrijven (`bericht`,
  optioneel `status`)

De rest van de API is alleen bereikbaar met een beheerderssessie (HttpOnly-koekje,
SameSite=Strict). Elke wijziging zit achter dat ene account.

## Ontwikkelen

```bash
node --test test/app.test.js     # 9 tests
node scripts/seed-demo.js        # demodata in een lege database
node scripts/record-demo.js uit/frames   # schermopname via CDP
```

Geen `npm install`: `node:sqlite`, `node:crypto`, `node:http` en de rest zitten
in Node zelf. De tests starten de server op een vrije poort met een tijdelijke
database.

## Opbouw

```
server.js          http-server, routes, achtergrondmetingen, sessies
lib/checks.js      site meten (status, tijd, versie, TLS) en host scannen
lib/github.js      repo's, tags, commits en CI via de GitHub-API
public/            index.html (één bestand), sw.js, manifest, iconen
scripts/           seed-demo.js, record-demo.js
test/              node:test, 9 tests
docs/              schermafbeeldingen en de demo-video
```

## Licentie

Eigen werk van Werdens Media. Checkmk is alleen als inspiratie gebruikt voor de
functielijst; er is geen regel code uit dat project overgenomen.
