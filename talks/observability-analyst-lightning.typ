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

#slide(title: [Grafana Assistant])[
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
]

#pagebreak()

#slide(title: [Was ist ein Agent?])[
  #rail(width: rail_wide)[
    #diagram("assets/agent-loop.svg")
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
  #rail(width: rail_wide)[
    #framed[
      #align(center)[
        #image("assets/prometheus-tool.svg", height: 5.55cm)
      ]
    ]

    #v(0.22cm)
    #grid(
      columns: (1fr, 1fr),
      gutter: 12pt,
      block(
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
      ],
      card([Tool-Ergebnis])[
        `seriesCount`, `min`, `max`, `last`, Fehlerhinweise
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
