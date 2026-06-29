package plugin

import (
	"fmt"
	"math"
	"strings"
)

type dashboardValidationReport struct {
	Warnings    []dashboardValidationWarning `json:"warnings,omitempty"`
	LayoutFixes []dashboardLayoutFix         `json:"layoutFixes,omitempty"`
}

type dashboardValidationWarning struct {
	Code       string `json:"code"`
	Message    string `json:"message"`
	PanelID    *int   `json:"panelId,omitempty"`
	PanelTitle string `json:"panelTitle,omitempty"`
}

type dashboardLayoutFix struct {
	PanelID    *int   `json:"panelId,omitempty"`
	PanelTitle string `json:"panelTitle,omitempty"`
	Message    string `json:"message"`
}

type dashboardGridRect struct {
	x int
	y int
	w int
	h int
}

func validateAndNormalizeDashboard(dashboard map[string]any) *dashboardValidationReport {
	panels := dashboardPanelMaps(dashboard["panels"])
	if len(panels) == 0 {
		return nil
	}

	report := &dashboardValidationReport{}
	assignDashboardPanelIDs(panels, report)
	normalizeDashboardPanelLayouts(panels, report)
	for _, panel := range panels {
		validateDashboardPanelQuality(panel, report)
	}

	if len(report.Warnings) == 0 && len(report.LayoutFixes) == 0 {
		return nil
	}
	return report
}

func assignDashboardPanelIDs(panels []map[string]any, report *dashboardValidationReport) {
	seen := map[int]bool{}
	nextID := 1
	for _, panel := range panels {
		if id, ok := dashboardPanelID(panel); ok && id >= nextID {
			nextID = id + 1
		}
	}

	for _, panel := range panels {
		id, ok := dashboardPanelID(panel)
		if ok && id > 0 && !seen[id] {
			seen[id] = true
			continue
		}

		for seen[nextID] {
			nextID++
		}
		panel["id"] = nextID
		seen[nextID] = true
		report.addWarning("panel_id_assigned", fmt.Sprintf("Assigned panel id %d.", nextID), panel)
		nextID++
	}
}

func normalizeDashboardPanelLayouts(panels []map[string]any, report *dashboardValidationReport) {
	occupied := []dashboardGridRect{}
	nextY := 0
	for _, panel := range panels {
		rect, valid := dashboardPanelGrid(panel)
		if !valid {
			rect = dashboardGridRect{x: 0, y: nextY, w: 24, h: defaultDashboardPanelHeight(panel)}
			report.addWarning("layout_missing", "Panel was missing a complete gridPos; assigned the next available position.", panel)
			report.addLayoutFix("Assigned missing gridPos.", panel)
		}

		rect, changed, overflow := sanitizeDashboardGridRect(rect, defaultDashboardPanelHeight(panel))
		if overflow {
			report.addWarning("layout_overflow", "Panel grid position exceeded Grafana's 24-column width and was clamped.", panel)
		}
		if changed {
			report.addLayoutFix("Clamped invalid gridPos values.", panel)
		}

		if dashboardGridCollides(rect, occupied) {
			report.addWarning("layout_collision", "Panel grid position overlapped an earlier panel and was moved to the next available position.", panel)
			rect = firstAvailableDashboardGridRect(rect.w, rect.h, nextY, occupied)
			report.addLayoutFix("Moved overlapping panel to the next available grid position.", panel)
		}

		panel["gridPos"] = map[string]any{"x": rect.x, "y": rect.y, "w": rect.w, "h": rect.h}
		occupied = append(occupied, rect)
		if rect.y+rect.h > nextY {
			nextY = rect.y + rect.h
		}
	}
}

func validateDashboardPanelQuality(panel map[string]any, report *dashboardValidationReport) {
	if strings.TrimSpace(dashboardPanelTitle(panel)) == "" {
		report.addWarning("panel_title_missing", "Panel is missing a title.", panel)
	}

	if dashboardPanelType(panel) == "table" && !dashboardTableHasColumnControl(panel) {
		report.addWarning("table_columns_uncontrolled", "Table panel does not explicitly filter or organize visible columns.", panel)
	}
}

func dashboardPanelMaps(raw any) []map[string]any {
	values, ok := raw.([]any)
	if !ok {
		return nil
	}
	result := make([]map[string]any, 0, len(values))
	for _, value := range values {
		panel, ok := value.(map[string]any)
		if ok {
			result = append(result, panel)
		}
	}
	return result
}

func dashboardPanelGrid(panel map[string]any) (dashboardGridRect, bool) {
	grid, ok := panel["gridPos"].(map[string]any)
	if !ok {
		return dashboardGridRect{}, false
	}
	x, okX := dashboardInt(grid["x"])
	y, okY := dashboardInt(grid["y"])
	w, okW := dashboardInt(grid["w"])
	h, okH := dashboardInt(grid["h"])
	return dashboardGridRect{x: x, y: y, w: w, h: h}, okX && okY && okW && okH
}

func sanitizeDashboardGridRect(rect dashboardGridRect, defaultHeight int) (dashboardGridRect, bool, bool) {
	changed := false
	overflow := false
	if rect.w <= 0 {
		rect.w = 24
		changed = true
	}
	if rect.w > 24 {
		rect.w = 24
		changed = true
		overflow = true
	}
	if rect.h <= 0 {
		rect.h = defaultHeight
		changed = true
	}
	if rect.x < 0 {
		rect.x = 0
		changed = true
	}
	if rect.y < 0 {
		rect.y = 0
		changed = true
	}
	if rect.x > 23 {
		rect.x = 0
		changed = true
		overflow = true
	}
	if rect.x+rect.w > 24 {
		rect.x = max(0, 24-rect.w)
		changed = true
		overflow = true
	}
	return rect, changed, overflow
}

func firstAvailableDashboardGridRect(width, height, startY int, occupied []dashboardGridRect) dashboardGridRect {
	if width <= 0 || width > 24 {
		width = 24
	}
	if height <= 0 {
		height = 8
	}
	for y := max(0, startY); y < startY+10000; y++ {
		for x := 0; x <= 24-width; x++ {
			rect := dashboardGridRect{x: x, y: y, w: width, h: height}
			if !dashboardGridCollides(rect, occupied) {
				return rect
			}
		}
	}
	return dashboardGridRect{x: 0, y: max(0, startY), w: width, h: height}
}

func dashboardGridCollides(rect dashboardGridRect, occupied []dashboardGridRect) bool {
	for _, other := range occupied {
		if rect.x < other.x+other.w && rect.x+rect.w > other.x && rect.y < other.y+other.h && rect.y+rect.h > other.y {
			return true
		}
	}
	return false
}

func dashboardTableHasColumnControl(panel map[string]any) bool {
	transformations, ok := panel["transformations"].([]any)
	if !ok {
		return false
	}
	for _, transformation := range transformations {
		record, ok := transformation.(map[string]any)
		if !ok {
			continue
		}
		id, _ := record["id"].(string)
		if id == "filterFieldsByName" || id == "organize" {
			return true
		}
	}
	return false
}

func defaultDashboardPanelHeight(panel map[string]any) int {
	switch dashboardPanelType(panel) {
	case "row":
		return 1
	case "stat", "gauge", "bargauge", "barGauge":
		return 4
	case "text":
		return 5
	default:
		return 8
	}
}

func dashboardPanelID(panel map[string]any) (int, bool) {
	return dashboardInt(panel["id"])
}

func dashboardPanelTitle(panel map[string]any) string {
	title, _ := panel["title"].(string)
	return title
}

func dashboardPanelType(panel map[string]any) string {
	panelType, _ := panel["type"].(string)
	return panelType
}

func dashboardInt(raw any) (int, bool) {
	switch value := raw.(type) {
	case int:
		return value, true
	case int64:
		return int(value), true
	case float64:
		if math.Trunc(value) == value {
			return int(value), true
		}
	case float32:
		value64 := float64(value)
		if math.Trunc(value64) == value64 {
			return int(value), true
		}
	}
	return 0, false
}

func (r *dashboardValidationReport) addWarning(code string, message string, panel map[string]any) {
	warning := dashboardValidationWarning{
		Code:       code,
		Message:    message,
		PanelTitle: dashboardPanelTitle(panel),
	}
	if id, ok := dashboardPanelID(panel); ok {
		warning.PanelID = &id
	}
	r.Warnings = append(r.Warnings, warning)
}

func (r *dashboardValidationReport) addLayoutFix(message string, panel map[string]any) {
	fix := dashboardLayoutFix{
		Message:    message,
		PanelTitle: dashboardPanelTitle(panel),
	}
	if id, ok := dashboardPanelID(panel); ok {
		fix.PanelID = &id
	}
	r.LayoutFixes = append(r.LayoutFixes, fix)
}
