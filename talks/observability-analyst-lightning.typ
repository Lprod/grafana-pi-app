#let bg = rgb("#ffffff")
#let panel = rgb("#ffffff")
#let panel_deep = rgb("#f4fbfe")
#let stroke = rgb("#c7e6f4")
#let fg = rgb("#00354e")
#let muted_fg = rgb("#004b6f")
#let accent = rgb("#009EE3")

#set page(
  width: 25.4cm,
  height: 14.2875cm,
  margin: 0cm,
  fill: bg,
)
#set text(font: "Open Sans", size: 13.5pt, fill: fg)
#set par(leading: 0.7em)
#set list(marker: "•", indent: 0.35cm, body-indent: 0.2cm)

#let soft(body) = text(fill: muted_fg)[#body]
#let mono(body) = text(font: "Noto Sans Mono", size: 8.1pt, fill: muted_fg)[#body]
#let rail_main = 92%
#let rail_wide = 96%
#let rail_compact = 86%

#let rail(width: rail_main, body) = align(center)[
  #block(width: width)[
    #set align(left)
    #body
  ]
]

#let card(title, body, fill: panel) = block(
  width: 100%,
  inset: 9pt,
  radius: 6pt,
  fill: fill,
  stroke: 0.7pt + stroke,
)[
  #text(size: 10.4pt, weight: "bold", fill: accent)[#title]
  #v(5pt)
  #text(size: 9pt, fill: muted_fg)[#body]
]

#let code_panel(title, body) = block(
  width: 100%,
  inset: 7pt,
  radius: 6pt,
  fill: panel,
  stroke: 0.7pt + stroke,
)[
  #text(size: 9.2pt, weight: "bold", fill: accent)[#title]
  #v(3pt)
  #set text(font: "Noto Sans Mono", size: 5.45pt, fill: fg)
  #body
]

#let note(body) = block(
  width: 100%,
  inset: 9pt,
  radius: 6pt,
  fill: panel_deep,
  stroke: 0.9pt + accent,
)[
  #text(size: 10.2pt, fill: fg)[#body]
]

#let framed(body, fill: panel_deep, inset: 6pt, radius: 7pt) = block(
  width: 100%,
  inset: inset,
  radius: radius,
  fill: fill,
  stroke: 0.7pt + stroke,
)[
  #body
]

#let diagram(path) = framed[
  #image(path, width: 100%)
]

#let diagram_note(path, width: rail_main, body) = rail(width: width)[
  #diagram(path)
  #v(0.22cm)
  #note(body)
]

#let slide(title: none, body) = block(
  width: 100%,
  height: 100%,
  inset: (x: 1.05cm, y: 0.78cm),
)[
  #if title != none {
    text(size: 24pt, weight: "bold", fill: fg)[#title]
    v(4pt)
    line(length: 100%, stroke: 0.7pt + stroke)
  }
  #v(0.2cm)
  #body
]

#slide(title: [Observability Analyst])[
  #v(0.22cm)
  #text(size: 17pt, fill: muted_fg)[
    KI-Unterstützung für Betrieb, Problemanalyse und Dashboards in Grafana.
  ]

  #v(0.5cm)
  #grid(
    columns: (1fr, 1fr, 1fr),
    gutter: 10pt,
    card([Probleme eingrenzen])[
      Metriken finden, Auffälligkeiten prüfen und Befunde mit Evidenz erklären.
    ],
    card([Betrieb unterstützen])[
      Grafana-Kontext nutzen: Datasources, Dashboards, Berechtigungen und Zeiträume.
    ],
    card([Dashboards erzeugen])[
      Jsonnet entwerfen, rendern und erst nach Freigabe als Managed Dashboard speichern.
    ],
  )

  #v(0.48cm)
  #note[
    Der Agent plant die Analyse. Die Grafana-App kontrolliert Datenzugriff,
    Werkzeugauswahl und persistente Änderungen.
  ]
]

#pagebreak()

#slide(title: [Was ist ein Agent?])[
  #diagram_note("assets/agent-loop.svg", width: rail_wide)[
    Ein Agent ist ein Sprachmodell plus Werkzeuge, Laufzeit und Regeln. Die KI
    schlägt den nächsten Schritt vor; die Anwendung validiert, führt aus oder lehnt ab.
  ]
]

#pagebreak()

#slide(title: [Architektur in Grafana])[
  #rail(width: rail_main)[
    #diagram("assets/pi-architecture.svg")
  ]
]

#pagebreak()

#slide(title: [Tool: query_prometheus])[
  #grid(
    columns: (1.28fr, 0.82fr),
    gutter: 12pt,
    diagram("assets/prometheus-tool.svg"),
    [
      #block(
        width: 100%,
        inset: 10pt,
        radius: 6pt,
        fill: panel,
        stroke: 0.7pt + stroke,
      )[
        #mono[
          query_prometheus(\{
            datasourceUid: "prometheus",
            query: "rate(http_requests_total[5m])",
            type: "range",
            start: "now-1h",
            end: "now"
          \})
        ]
      ]

      #v(8pt)
      #card([Tool-Ergebnis])[
        `seriesCount`, `min`, `max`, `last`, Fehlerhinweise
      ]
    ],
  )
]

#pagebreak()

#slide(title: [Dashboards aus Jsonnet])[
  #rail(width: rail_main)[
    #framed[
      #align(center)[
        #image("assets/jsonnet-loop.svg", height: 3.75cm)
      ]
    ]

    #v(0.12cm)
    #grid(
      columns: (1fr, 1fr),
      gutter: 12pt,
      code_panel([dashboard.jsonnet])[
```jsonnet
local ds = { type: 'prometheus', uid: 'prom-main' };
local panel(title, expr) = {
  type: 'timeseries',
  title: title,
  datasource: ds,
  gridPos: { x: 0, y: 0, w: 12, h: 8 },
  targets: [{ refId: 'A', datasource: ds, expr: expr }],
};

{
  title: 'API Service RED',
  uid: 'api-service-red',
  tags: ['service'],
  timezone: 'browser',
  time: { from: 'now-6h', to: 'now' },
  schemaVersion: 39,
  panels: [panel('Request rate',
    'sum(rate(http_requests_total[$__rate_interval]))')],
}
```
      ],
      code_panel([kompiliertes JSON])[
```json
{
  "title": "API Service RED",
  "uid": "api-service-red",
  "tags": ["service", "managed-by-observability-analyst"],
  "timezone": "browser",
  "time": { "from": "now-6h", "to": "now" },
  "schemaVersion": 39,
  "panels": [{
    "type": "timeseries",
    "title": "Request rate",
    "datasource": { "type": "prometheus", "uid": "prom-main" },
    "gridPos": { "x": 0, "y": 0, "w": 12, "h": 8 },
    "targets": [
      { "refId": "A", "datasource": { "uid": "prom-main" },
        "expr": "sum(rate(http_requests_total[$__rate_interval]))" }
    ]
  }]
}
```
      ],
    )
  ]
]

#pagebreak()

#slide(title: [Kontrolle und Freigabe])[
  #rail(width: rail_compact)[
    #diagram("assets/guardrails.svg")
  ]

  #v(0.28cm)
  #align(center)[
    #text(size: 16pt, weight: "bold", fill: fg)[
      Agent = Modell + Tools + Laufzeit + Regeln
    ]
  ]
]
