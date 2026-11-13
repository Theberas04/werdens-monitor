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

**TopDesk-laag** — de tickets zijn een echt servicedesk geworden: prioriteit uit
impact × urgentie, een SLA per prioriteit met een klok die pauzeert zodra een
ticket op de klant of de leverancier wacht, een kennisbank met oplossingen die je
hergebruikt, een rapportage met SLA-gehaald en de verdeling per categorie, en een
publieke meldpagina waar een klant zelf een melding achterlaat. Zie
[TopDesk-laag](#topdesk-laag).

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

**Mijn software** — al je eigen apps op één plek: per app de versie, de repo en
of GitHub een nieuwere commit heeft. Met één klik werk je bij (git pull + de
dienst herstarten). Zo is één dashboard-login genoeg en hoef je niet bij elke
app een eigen beheerderswachtwoord te hebben. Zie [Mijn software](#mijn-software).

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

Krijg je bij het bijwerken **`EROFS, Read-only file system`**, dan is de
systemd-unit van een oude installatie nog ingesteld op alleen `data/` (van vóór
1.3). Draai het bijwerkscript hieronder één keer; dat zet `ReadWritePaths` op de
hele installatiemap en herstart de dienst. Daarna werkt de knop in het dashboard.

Krijg je **`fatal: detected dubious ownership in repository`**, dan is dat geen
fout van jou: de installatiemap is van de dienstgebruiker `werdens` en git draait
als root. Het bijwerkscript zet de map daarom zelf op de vrijstellingslijst
(`safe.directory`) en gebruikt de tarball als git alsnog weigert. Handmatig kan
het ook:

```bash
git config --global --add safe.directory /opt/werdens-monitor
```

Vanuit de terminal bijwerken — bijvoorbeeld als de draaiende versie nog geen
update-knop heeft. Dit vervangt alleen de programmabestanden en herstart de
dienst; de database blijft staan:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Theberas04/werdens-monitor/refs/heads/main/deploy/bijwerken.sh)"
```

De raw-URL van GitHub heeft een cache van een paar minuten. Krijg je na een
nieuwe release nog de oude versie, gebruik dan een commit-URL in plaats van
`refs/heads/main`:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Theberas04/werdens-monitor/<commit>/deploy/bijwerken.sh)"
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

### UniFi, TrueNAS en Proxmox koppelen

**Apparaten → Apparaat toevoegen**. Bij *UniFi-controller* vul je de URL van de
controller in (`https://192.168.1.1` of met `:8443`) en een beheerdersaccount;
de monitor logt in en leest de apparaten, clients en de gezondheid per onderdeel.
Bij *TrueNAS* maak je in de webinterface een API-sleutel aan (Instellingen →
API-sleutels) en vul je die als wachtwoord in. *HTTP/JSON* is voor alles met een
JSON-endpoint: de scalars uit het antwoord komen als waarden op de detailpagina.

Bij *Proxmox VE* gebruik je de API van de host zelf — geen agent nodig:

1. In de Proxmox-webinterface: **Datacenter → Permissions → API Tokens → Add**.
   Kies de gebruiker (bijvoorbeeld `root@pam`), geef het token een naam
   (`monitor`) en laat *Privilege Separation* uit staan, anders ziet het token
   alleen zijn eigen rechten.
2. Kopieer het token-secret dat één keer verschijnt.
3. In de monitor: **Apparaten → Apparaat toevoegen**, soort *Proxmox VE*, URL
   `https://<proxmox-host>:8006`, gebruiker `root@pam!monitor` en als
   wachtwoord/API-key het secret.

**Zonder token** kan het ook: vul bij gebruiker `root@pam` (zonder uitroepteken)
en bij wachtwoord het gewone wachtwoord in. De monitor haalt dan eerst een ticket
op. Dat werkt alleen als 2FA uit staat voor dat account; met 2FA is een API-token
de enige weg.

Staat *Privilege Separation* bij het token toch aan, geef het token dan rechten:
**Datacenter → Permissions → Add → API Token**, pad `/`, rol `PVEAuditor`, en zet
*Propagate* aan. Let op: geef die rol aan **het token** (`root@pam!monitor`) en
niet aan de gebruiker `root@pam` — met *Privilege Separation* aan gelden alleen de
rechten van het token zelf. Zonder die rechten geeft Proxmox wél de nodenamen en
de versie maar geen cijfers; de monitor zegt dat dan met zoveel woorden in plaats
van overal 0% te tonen.

Twijfel je of het aan de rechten ligt? Open het apparaat en druk op
**Rechten testen**. Je krijgt per Proxmox-endpoint de HTTP-uitkomst te zien
(`/version`, `/access/permissions`, `/nodes`, `/cluster/resources`,
`/nodes/<node>/status`), welke rechten Proxmox voor deze token teruggeeft, en een
conclusie in gewone taal. Zo zie je het verschil tussen een ongeldig token (401)
en een geldig token zonder rechten (403) zonder in de Proxmox-GUI te hoeven
zoeken.

Let op: een Proxmox-host hoort onder **Apparaten**, niet onder *Servers*. Bij
*Servers* hoort een agent-script op de machine; een Proxmox-host leest de monitor
rechtstreeks via de API.

De monitor leest dan de nodes met hun CPU-, RAM- en schijfbelasting en load, de
VM's en containers met hun status, en de opslag per node. Een offline node of
een opslag boven 90% maakt het apparaat `fout` en stuurt — als Slack aanstaat —
een melding. Het zelfondertekende certificaat van Proxmox wordt geaccepteerd;
het token gaat als `PVEAPIToken=gebruiker@realm!naam=secret` mee.

Let op: poort 8006 moet vanaf de monitor bereikbaar zijn. Staat de monitor in een
LXC op dezelfde host, gebruik dan het LAN-adres van de host (niet `localhost`).

Een apparaat in onderhoud zet je op zijn detailpagina met de knop **Onderhoud**:
je kiest een eindtijd en een reden. Tijdens het venster blijft de monitor meten
— zodat de status klopt als je klaar bent — maar er gaan geen meldingen naar
Slack. Het venster staat in de lijst met een blauw *onderhoud*-label en je stopt
het met **Stoppen** op de detailpagina. Zo geldt hetzelfde gedrag als bij een
IP-adres.

Wachtwoorden en sleutels staan in de database, niet in de repo; de API geeft ze
nooit terug (wel of er een geheim is ingesteld).

## Mijn software

De tab **Software** toont de apps die je zelf hebt gemaakt en gebruikt. Elke app
is een map met een git-repo en een `package.json` (de versie komt daaruit; heeft
een app geen `package.json`, dan uit een `VERSION`-bestand of de git-tag).

Per app zie je de draaiende versie, de repo, de laatste commit en of GitHub een
nieuwere heeft. **Controleer op updates** kijkt bij alle apps tegelijk;
**Bijwerken** doet een `git pull --ff-only` en herstart de dienst. Eén
dashboard-login is genoeg — je hoeft niet bij elke app een eigen
beheerderswachtwoord te hebben.

Het dashboard zoekt apps in de huis-map van de dienst (standaard
`/home/hermes`). Met `EIGENAPPS_MAP` verleg je die map, bijvoorbeeld naar
`/opt/apps`. Bij het toevoegen kun je uit de gevonden apps kiezen; een map
buiten de eigen map wordt geweigerd.

Wat de bijwerk-knop **niet** doet: een werkmap met niet-gecommitte wijzigingen
overschrijven. Is de werkmap niet schoon, dan stopt hij met een melding en blijft
de code staan. Zo gaan je eigen aanpassingen nooit verloren.

### Zoeken in het netwerk

Niet elke app draait op de machine waar de monitor staat. Met **Zoek in het
netwerk** loopt het dashboard je LAN langs (de /24 om elk eigen adres) en kijkt
per open poort of er een app van jou achter zit.

Een app wordt herkend aan een klein bestand dat elke web-app kan serveren:

```json
/.well-known/werdens-app.json
{
  "naam": "VoorraadThuis",
  "versie": "1.4.2",
  "repo": "Theberas04/voorraadthuis"
}
```

Ook `/werdens-app.json` en een `<meta name="werdens-app" content="naam|versie|repo">`
in de pagina werken. Apps zonder vingerafdruk worden herkend aan hun paginatitel
(de lijst `BEKEND` in `lib/eigenapps-netwerk.js`); routers en printers blijven
dus buiten beeld. Deze monitor serveert zijn eigen vingerafdruk al, zodat een
volgende monitor hem terugvindt.

De afgetaste poorten staan in `APP_POORTEN` (80, 443, 3000, 5000, 8000, 8080,
8081, 8090, 8099, 9000, enz.) en zijn te overschrijven met
`EIGENAPPS_POORTEN=3000,8080`.

Gevonden apps komen met hun adres in de lijst: **Openen** opent de app,
**Vergeet** haalt hem uit de lijst zonder de app zelf te raken. Bijwerken kan
alleen voor apps die als map op deze machine staan; een app elders moet daar
zelf een `git pull` krijgen.

![Gevonden op het netwerk](docs/img/software-netwerk-desktop.png)

## Wachtwoord vergeten

### Vanaf de inlogpagina, met een code via Slack

Staat er een Slack-webhook ingesteld (Instellingen → Slack-meldingen), dan hoef je
niet bij de server te komen: klik op de inlogpagina op **Wachtwoord vergeten?** en
daarna op **Stuur code via Slack**. Je krijgt in Slack een code van zes cijfers;
vul die met je nieuwe wachtwoord in en je bent meteen ingelogd. Alle oude sessies
vervallen.

Zo is het beveiligd:

- de code is **tien minuten** geldig en werkt **één keer**;
- hij staat alleen als sha256-afdruk in de database (tabel `herstelcodes`), niet
  als platte tekst, en verdwijnt na gebruik of na het verlopen;
- na **vijf** foute pogingen is de code verbruikt;
- hooguit **één aanvraag per minuut** en **vijf per uur**, zodat niemand je
  Slack volspamt;
- elke aanvraag en elke geslaagde herstelactie komt in de gebeurtenissenlijst;
- zonder Slack-webhook weigert de app (`409`) en verwijst naar het script hieronder.

Het nieuwe wachtwoord komt niet in `data/admin-wachtwoord.txt`; dat bestand hoort
bij het gegenereerde wachtwoord van de installatie. Zet je wachtwoord dus meteen
goed, of noteer het.

### Vanaf de server, als je niet meer in de app komt

Het beheerderswachtwoord staat als scrypt-afdruk in de database. Ben je het kwijt,
draai dan vanaf de Proxmox-console in de LXC (of als root op de machine):

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Theberas04/werdens-monitor/refs/heads/main/deploy/reset-wachtwoord.sh)"
```

Het script zet meteen een nieuw wachtwoord in de database (16 tekens), wist alle
sessies, zet het wachtwoord ook in `data/admin-wachtwoord.txt` en herstart de
dienst als die bestaat. **Inloggen werkt direct**, ook zonder herstart. Wil je
zelf een wachtwoord kiezen:

```bash
NIEUW=minstens8tekens bash -c "$(curl -fsSL .../deploy/reset-wachtwoord.sh)"
```

`DROOG=1` laat eerst zien wat er zou gebeuren. `MAP` (standaard
`/opt/werdens-monitor`) en `DIENST` zijn aan te passen.

Let op: het inlogwachtwoord van het dashboard staat los van je Proxmox-wachtwoord.
Een nieuwe Proxmox-API-token of -wachtwoord verandert niets aan de dashboard-login;
gebruik daarvoor dit script of **Instellingen → Wachtwoord**.

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

| Rapportage | Kennisbank |
|---|---|
| ![](docs/img/rapportage-desktop.png) | ![](docs/img/kennisbank-desktop.png) |

| Ticketdetail | Publieke meldpagina |
|---|---|
| ![](docs/img/ticket-detail-desktop.png) | ![](docs/img/melden-desktop.png) |

| Mijn software | Apparaten |
|---|---|
| ![](docs/img/software-desktop.png) | ![](docs/img/apparaten-desktop.png) |

| Mijn software (mobiel) | Meldpagina (mobiel) |
|---|---|
| ![](docs/img/software-mobiel.png) | ![](docs/img/melden-mobiel.png) |

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
| `PORT` | `8080` | poort waarop het dashboard luistert |
| `PUBLIEK_POORT` | `8081` | poort van de publieke meldpagina; `0` = uit |
| `PUBLIEK_BIND` | `0.0.0.0` | IP-adres waarop de publieke meldpagina luistert |
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

## TopDesk-laag

De ticketmodule is opgezet naar het voorbeeld van TopDesk. Geen TopDesk-code: de
functies zijn nagemaakt in de eigen stack.

**Prioriteit uit impact × urgentie.** Je kiest bij een ticket de impact (hoeveel
mensen raakt het) en de urgentie (hoe snel moet het). De prioriteit volgt daaruit
met dezelfde matrix als in TopDesk: de hoogste van de twee telt zwaarder.

**SLA per prioriteit, met een pauzerende klok.** Elke prioriteit heeft een
afspraak voor de eerste reactie en voor de oplossing:

| Prioriteit | Eerste reactie | Oplossing |
|---|---|---|
| kritiek | 1 uur | 4 uur |
| hoog | 2 uur | 8 uur |
| normaal | 4 uur | 24 uur |
| laag | 8 uur | 48 uur |

Zolang een ticket op **wacht op klant** of **wacht op leverancier** staat, loopt
de klok niet door. Op het ticketdetail zie je vier klokken: eerste reactie,
oplossing (met de resterende tijd), verstreken tijd en de afspraak die erbij
hoort. Naast de statusbalk staat of het ticket binnen de SLA loopt, bijna over
tijd is of eroverheen is.

**Kennisbank.** Oplossingen die vaker terugkomen zet je als artikel in de
kennisbank: titel, probleem, oplossing, categorie en trefwoorden. Open je een
ticket, dan zie je onderaan de artikelen uit dezelfde categorie. Met **Invullen**
zet je de oplossing in het ticket, met **Gebruikt** houd je bij hoe vaak een
artikel is toegepast en met **Naar kennisbank** maak je van een opgelost ticket
in één klik een artikel. Zoeken gaat live op titel, probleem, oplossing en
trefwoorden.

**Rapportage.** Onder *Tickets → Rapportage* staat wat de SLA-laag bijhoudt: open
en kritiek open, hoeveel open tickets al over de afspraak zijn, welk percentage
binnen de SLA is afgerond (eerste reactie én oplossing), gemiddelde reactie- en
oplostijd, en de verdeling per prioriteit, per categorie en per behandelaar.

**Publieke meldpagina.** Op `/melden` laat een klant of collega zelf een melding
achter — naam, e-mail, categorie, hoe dringend, onderwerp, omschrijving en
optioneel een IP-adres. De melding komt binnen als ticket met kanaal
*meldpagina*, met de klantnaam en het e-mailadres erbij, en verschijnt meteen in
de lijst. De pagina werkt zonder sessie en is met dezelfde huisstijl opgemaakt.
Tegen misbruik zitten er drie remmen op: een verborgen veld dat leeg moet blijven
(honingpot), een minimale invultijd van drie seconden (een bot verstuurt meteen)
en een limiet per IP (maximaal één per 45 seconden en vijf per uur).

### De meldpagina op een eigen adres (voor Cloudflare)

De meldpagina hoeft niet op hetzelfde adres als het dashboard te staan. Met
`PUBLIEK_POORT` start de app een **tweede luisteraar** die alleen de meldpagina
en haar API bedient: geen inlogpagina, geen dashboard en geen andere
API-routes. Standaard is dat poort `8081`; `PUBLIEK_POORT=0` zet hem uit.

```bash
# /etc/werdens-monitor.env
PUBLIEK_POORT=8081
PUBLIEK_BIND=0.0.0.0
```

Daarna is de pagina bereikbaar op `http://<lxc-ip>:8081/` (en op
`http://<lxc-ip>:8081/melden`). Het dashboard blijft gewoon op `:8080`. Op het
tweede adres bestaat alleen de meldpagina: `/api/overzicht`, `/api/tickets` en
`/api/login` geven daar een 404, ook als iemand het adres raadt.

**Met Cloudflare Tunnel** (aanbevolen — je hoeft geen poort in de router open te
zetten):

1. Maak in Cloudflare Zero Trust een tunnel en een hostname, bijvoorbeeld
   `melden.werdensmedia.nl`.
2. Laat de tunnel naar `http://127.0.0.1:8081` wijzen.
3. Installeer `cloudflared` als dienst op de LXC.

```yaml
# /etc/cloudflared/config.yml
tunnel: <tunnel-id>
credentials-file: /etc/cloudflared/<tunnel-id>.json
ingress:
  - hostname: melden.werdensmedia.nl
    service: http://127.0.0.1:8081
  - service: http_status:404
```

### De meldpagina op een eigen IP-adres

Wil je de pagina niet alleen op een eigen poort, maar op een **eigen IP-adres**
— bijvoorbeeld omdat je er met Cloudflare een losse website van maakt — dan
krijgt de container een tweede netwerkkaart. Dat doe je op de **Proxmox-host**,
niet in de container:

```bash
IP=192.168.1.121 bash <(curl -fsSL https://raw.githubusercontent.com/Theberas04/werdens-monitor/refs/heads/main/deploy/proxmox/extra-ip.sh)
```

(Staat de repo al op de host, dan kan het ook met
`IP=192.168.1.121 bash deploy/proxmox/extra-ip.sh`.)

Het script doet vier dingen en controleert daarna of het werkt:

1. het geeft de container een tweede kaart (`net1`) met dat adres op dezelfde
   brug als `net0`;
2. het zet `PUBLIEK_BIND=192.168.1.121` en `PUBLIEK_POORT=8081` in
   `/etc/werdens-monitor.env`;
3. het herstart de dienst;
4. het vraagt `http://192.168.1.121:8081/healthz` op en zegt of de pagina
   antwoordt.

Daarna:

| Adres | Wat er staat |
| --- | --- |
| `http://192.168.1.109:8080` | het dashboard (blijft ongewijzigd) |
| `http://192.168.1.121:8081` | alleen de meldpagina |

Het dashboard stuurt `/melden` door naar het eigen adres, zodat het formulier
maar op één plek staat. In *Instellingen* zie je of de luisteraar echt draait
(`luistert` of `start niet` met de reden) en welke adressen deze machine heeft.

**Opties.** `CTID=120` (standaard 120), `BRIDGE=vmbr0`, `PREFIX=24`,
`PUBLIEK_POORT=8081`, `KAART=eth1`, `DROOG=1` (alleen laten zien wat er zou
gebeuren) en `FORCE=1` als het adres al antwoordt maar je zeker weet dat het
mag. Terugdraaien: `bash deploy/proxmox/extra-ip.sh --verwijderen`.

**Let op.** Het script herstart de container als de nieuwe kaart niet meteen
zichtbaar is; de monitor komt vanzelf terug (systemd). Staat de firewall van de
container aan, laat dan poort `8081` toe. Het dashboard blijft op alle adressen
luisteren; wil je dat ook beperken, zet dan `PORT` achter een firewall of
reverse proxy.

**Cloudflare.** De tunnel hoeft niet op het tweede adres te staan: wijst hij
naar `http://192.168.1.121:8081`, dan komt het verkeer van Cloudflare op de
meldpagina uit en niet op het dashboard. Staat `cloudflared` op deze container,
dan kan de service ook `http://127.0.0.1:8081` zijn.

**Waarom één proces en geen tweede container.** De meldingen moeten in dezelfde
database landen; een tweede container zou een tweede database krijgen en dan
staan de tickets op twee plekken. De tweede luisteraar deelt de database wél en
het dashboard niet: op dat adres bestaat alleen de meldpagina. Wil je de pagina
toch als losse site hosten, zet dan een reverse proxy of Cloudflare Tunnel voor
`PUBLIEK_POORT` en houd het dashboard achter de eigen tunnel.

**Ticket maken van een storing.** Op de meldingen-tab heeft elke storing een
knop **Ticket maken**: de melding komt als eerste systeembericht in het ticket,
de ernst bepaalt de prioriteit en de soort bepaalt de categorie (een host-melding
gaat naar netwerk, een certificaatmelding naar website). Bestaat er al een open
ticket voor die melding, dan opent hij dat in plaats van een tweede aan te maken.
Op het ticketdetail zie je de oorspronkelijke melding met de ernst en het
meetmoment.

**Statussen.** *open*, *in behandeling*, *wacht op Tom*, *wacht op klant*,
*wacht op leverancier*, *opgelost* en *gesloten*. De eerste vier zijn de
open-status; de twee wacht-statussen zetten de SLA-klok stil.

## Ontwikkelen

```bash
node --test test/*.test.js       # 45 tests
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
lib/eigenapps.js       eigen apps vinden, versie lezen, controleren en bijwerken
lib/slack.js           Slack-webhook: bericht opbouwen en versturen
public/                index.html (één bestand), melden.html (publieke meldpagina), sw.js, manifest, iconen
scripts/werdens-agent.js  hardware-agent voor andere servers (geen npm)
scripts/               seed-demo.js, shoot.js, shoot-slack.js, record-demo.js
deploy/                installeer.sh, bijwerken.sh, verwijderen.sh, reset-wachtwoord.sh
deploy/proxmox/        maak-lxc.sh (nieuwe container), extra-ip.sh (meldpagina op een eigen IP)
test/                  node:test, 45 tests (incl. SLA, prioriteitsmatrix, kennisbank, meldpagina op eigen adres, eigen software)
docs/                  schermafbeeldingen, hero en de demo-video
```

## Licentie

Eigen werk van Werdens Media. Checkmk is alleen als inspiratie gebruikt voor de
functielijst; er is geen regel code uit dat project overgenomen.
