# Werdens Monitor

Eigen infra- en websitedashboard voor Werdens Media. Geen fork van Checkmk en
geen Checkmk-code: de *functies* zijn nagemaakt in een eigen stack — één
Node-proces, de ingebouwde `node:sqlite`, geen npm-afhankelijkheden, geen Docker,
en een Nederlandse mobiel-eerste interface die als PWA te installeren is.

![Werdens Monitor — al je sites, repo's en IP-adressen in één dashboard](docs/img/hero.png)

[![Node 22.5+](https://img.shields.io/badge/Node-22.5%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Geen npm-afhankelijkheden](https://img.shields.io/badge/npm-0-2ea3f2)](package.json)
[![SQLite](https://img.shields.io/badge/SQLite-ingebouwd-003b57?logo=sqlite&logoColor=white)](https://nodejs.org/api/sqlite.html)
[![PWA](https://img.shields.io/badge/PWA-installeerbaar-1e73be)](public/manifest.webmanifest)
[![Licentie: eigen werk](https://img.shields.io/badge/licentie-eigen%20werk-14b8a6)](README.md#licentie)

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

**Apparaten** — kastjes en diensten met een eigen API, zonder agent: de
UniFi-controller (access points, switches, clients, WAN/LAN-gezondheid), TrueNAS
(versie, uptime, pools, schijven, openstaande meldingen) en elke HTTP-URL die
JSON teruggeeft. Bij een fout apparaat komt er een melding, net als bij een host.

**Netwerk scannen** — de monitor loopt het eigen subnet af en toont welk IP
erop staat, met hostnaam, MAC-adres en open poorten. Wat je wilt volgen vink je
aan en zet je in één keer in de IP-lijst; bestaande hosts worden overgeslagen.
Scant alleen privé-adressen, geen internet.

**Servers** — CPU, geheugen, schijven, GPU, temperatuur en netwerk per server.
De monitor leest zijn eigen machine rechtstreeks uit `/proc`, `/sys` en `df`;
andere servers draaien een klein agent-script dat elke minuut dezelfde cijfers
post. Geen SSH-sleutels, geen poorten open behalve de monitor zelf.

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
| Meldingen (mail/SMS) | deels | storingen in dashboard en log, plus push naar Slack via een inkomende webhook; mail/SMS nog niet |
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
| Hardware: CPU, RAM, schijf, GPU | ja | per server, met gebruik, temperatuur en historie; eigen machine plus agent-script |
| Voorraad (hardware/software) | nee | buiten scope; wel versie per site en per GitHub-repo |
| BI / voorspellingen | nee | geen historiek lang genoeg op dagbasis |

## Slack-meldingen

Zet in **Instellingen → Slack-meldingen** de webhook-URL van een Slack-kanaal en
vink *Meldingen versturen* aan. Een nieuwe storing gaat dan als bericht naar dat
kanaal; met *Ook herstel melden* komt er ook bericht als iets weer werkt. Met
**Testbericht** controleer je de koppeling meteen.

Een storing wordt één keer gemeld. Blijft hij open, dan komt er niet elke
meetronde opnieuw een bericht — pas na 20 minuten, of zodra de toestand
verandert. Herstel gaat altijd door, ook als het kanaal even niet bereikbaar was.

Webhook maken: in Slack een app aanmaken → *Incoming Webhooks* → *Add New
Webhook to Workspace* → kanaal kiezen → URL kopiëren. De URL is een geheim: hij
staat in de database van de monitor en niet in de repo of in de omgeving.

## GitHub-token in de app

De Projecten-tab en het bijwerken werken met de publieke GitHub-API, maar op een
lager limiet (60 verzoeken per uur). Met een token gaat dat naar 5000 en werken
ook besloten repo's. Zet hem in **Instellingen → GitHub-token**; de monitor test
het token eerst bij GitHub en bewaart het pas als het werkt. Daarna is het token
niet meer terug te lezen — je ziet alleen nog dát het er is en waar het vandaan
komt (dashboard of omgeving).

Een token maak je op GitHub → *Settings* → *Developer settings* → *Personal
access tokens*. Voor openbare repo's volstaat geen enkele scope; voor besloten
repo's heb je `repo` nodig.

## De software bijwerken

**Instellingen → Bijwerken** toont de draaiende versie en de nieuwste op GitHub.
Met **Nu bijwerken** haalt de monitor de nieuwe tarball op, controleert de
syntax van de nieuwe `server.js` vóór er iets overschreven wordt, laat `data/`
met de database staan en herstart via systemd. Lukt de controle niet, dan blijft
de oude versie draaien.

Dit werkt bij een installatie via het LXC-script of de installer; draai je de app
los tijdens het ontwikkelen, gebruik dan `git pull`.

Vanuit de terminal bijwerken — bijvoorbeeld als de draaiende versie nog geen
update-knop heeft. Dit vervangt alleen de programmabestanden en herstart de
dienst; de database blijft staan:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Theberas04/werdens-monitor/refs/heads/main/deploy/bijwerken.sh)"
```

Staat de app in een LXC, dan vanaf de Proxmox-host:

```bash
pct exec 120 -- bash -c 'bash -c "$(curl -fsSL https://raw.githubusercontent.com/Theberas04/werdens-monitor/refs/heads/main/deploy/bijwerken.sh)"'
```

`MAP` (standaard `/opt/werdens-monitor`) en `DIENST` zijn aan te passen. Zonder
git-installatie valt het script terug op de tarball van GitHub; `DROOG=1` laat
alleen zien wat er zou gebeuren.

### Verwijderen

Een oude installatie — bijvoorbeeld een die nog als dienst op de Proxmox-host
staat in plaats van in een eigen LXC — haal je zo weg:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Theberas04/werdens-monitor/refs/heads/main/deploy/verwijderen.sh)"
```

Dat stopt de dienst, zet de autostart uit en verwijdert het systemd- en
omgevingsbestand. De installatiemap met de database blijft staan; `ALLES=1`
vooraf maakt ook die leeg. `DROOG=1` toont eerst wat er zou gebeuren.

### UniFi en TrueNAS koppelen

**Apparaten → Apparaat toevoegen**. Bij *UniFi-controller* vul je de URL van de
controller in (`https://192.168.1.1` of met `:8443`) en een beheerdersaccount;
de monitor logt in en leest de apparaten, clients en de gezondheid per onderdeel.
Bij *TrueNAS* maak je in de webinterface een API-sleutel aan (Instellingen →
API-sleutels) en vul je die als wachtwoord in. *HTTP/JSON* is voor alles met een
JSON-endpoint: de scalars uit het antwoord komen als waarden op de detailpagina.

Wachtwoorden en sleutels staan in de database, niet in de repo; de API geeft ze
nooit terug (wel of er een geheim is ingesteld).

## Schermen

![Servers met CPU, geheugen, schijf en GPU](docs/img/servers-desktop.png)

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

| Servers | Serverdetail |
|---|---|
| ![](docs/img/servers-desktop.png) | ![](docs/img/server-detail-desktop.png) |

| Slack-meldingen |
|---|
| ![](docs/img/slack-meldingen.png) |

Een rondleiding door de app: **[demo-video (42 s, 1440×900)](docs/video/werdens-monitor-demo.mp4)**.

## Installeren

### Als eigen LXC (aanbevolen op Proxmox)

Dit maakt een aparte container aan met een eigen IP en installeert de monitor
erin — dus niet als dienst op de Proxmox-host zelf. Draai dit als root op de
host:

```bash
CTID=120 ADMIN_PASSWORD='kies-er-een' GITHUB_TOKEN='ghp_...' \
  bash <(curl -fsSL https://raw.githubusercontent.com/Theberas04/werdens-monitor/refs/heads/main/deploy/proxmox/maak-lxc.sh)
```

Zonder `CTID` pakt het script het eerste vrije nummer vanaf 120. Zonder
`ADMIN_PASSWORD` maakt het script een wachtwoord en print dat aan het eind.
Standaard dhcp; een vast adres geef je mee met
`IP=192.168.1.130/24,gw=192.168.1.1`.
`STORAGE`, `CORES`, `MEMORY`, `DISK` en `BRIDGE` zijn ook aan te passen.
`DROOG=1` toont alleen wat er zou gebeuren. Het root-wachtwoord van de
container wordt aan het eind geprint.

### Op een bestaande Debian/Ubuntu-machine

Eén regel op de Proxmox-host of een bestaande LXC (Debian/Ubuntu). Ontbreekt Node 22.5 of is het
te oud, dan installeert het script Node 22 zelf via NodeSource. Een repo die
niet bereikbaar is (bijv. de Proxmox-enterprise-repo zonder abonnement) houdt
de installatie niet tegen: apt-fouten worden overgeslagen en er is een terugval
op de officiële Node-tarball:

```bash
curl -fsSL https://raw.githubusercontent.com/Theberas04/werdens-monitor/refs/heads/main/deploy/installeer.sh | bash
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
| `SERVER_NAAM` | hostnaam | naam van de eigen server in de lijst |
| `SLACK_TIMEOUT_MS` | `8000` | tijdslimiet voor een Slack-bericht |

## Servers koppelen

De eigen monitor verschijnt automatisch: hij leest `/proc`, `/sys` en `df` en
toont CPU, geheugen, schijven, GPU en temperatuur van de machine waarop hij
draait. Wil je een andere server volgen, voeg hem dan toe via **Servers →
Server toevoegen**. Je krijgt een token; zet dat op die server in de omgeving
en start het agent-script:

```bash
# eenmalig testen
BASE_URL=https://monitor.example.nl TOKEN=<token> EENMALIG=1 node werdens-agent.js

# blijvend, bijvoorbeeld elke minuut via cron
* * * * * BASE_URL=https://monitor.example.nl TOKEN=<token> node /opt/werdens-agent.js >/dev/null 2>&1
```

Het script heeft geen npm nodig, alleen Node. Het leest dezelfde bronnen als de
monitor zelf. `nvidia-smi` wordt gebruikt als het er is; zonder NVIDIA-kaart
toont de monitor de Intel/AMD-kaart uit `/sys/class/drm` zonder belastingcijfer.
Het token hoort bij één server en kan per server vernieuwd worden; de agent
hoeft dan alleen zijn `TOKEN` bij te werken.

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
node --test test/*.test.js       # 14 tests
node scripts/seed-demo.js        # demodata in een lege database
node scripts/record-demo.js uit/frames   # schermopname via CDP
```

Geen `npm install`: `node:sqlite`, `node:crypto`, `node:http` en de rest zitten
in Node zelf. De tests starten de server op een vrije poort met een tijdelijke
database.

## Opbouw

```
server.js              http-server, routes, achtergrondmetingen, sessies
lib/checks.js          site meten (status, tijd, versie, TLS) en host scannen
lib/github.js          repo's, tags, commits en CI via de GitHub-API
lib/hardware.js        CPU, RAM, schijven, GPU, temperatuur en netwerk uitlezen
lib/netwerk.js         subnetten bepalen, adressen aftasten, ARP en reverse DNS
lib/update.js          nieuwste versie van GitHub halen, uitpakken, herstarten
lib/apparaten.js       UniFi, TrueNAS en generieke HTTP-apparaten uitlezen
lib/slack.js           Slack-webhook: bericht opbouwen en versturen
public/                index.html (één bestand), sw.js, manifest, iconen
scripts/werdens-agent.js  hardware-agent voor andere servers (geen npm)
scripts/               seed-demo.js, shoot.js, shoot-slack.js, record-demo.js
test/                  node:test, 14 tests
docs/                  schermafbeeldingen, hero en de demo-video
```

## Licentie

Eigen werk van Werdens Media. Checkmk is alleen als inspiratie gebruikt voor de
functielijst; er is geen regel code uit dat project overgenomen.
