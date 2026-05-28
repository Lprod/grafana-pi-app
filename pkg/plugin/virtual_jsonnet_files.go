package plugin

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	defaultVirtualJsonnetPath = "dashboard.jsonnet"
	maxJsonnetFileReadLines   = 200
)

type virtualJsonnetFileStore struct {
	mu    sync.Mutex
	files map[string]virtualJsonnetFile
}

type virtualJsonnetFile struct {
	SessionID string
	Path      string
	Content   string
	Version   int
	UpdatedAt time.Time
}

type jsonnetFileReference struct {
	SessionID string `json:"sessionId,omitempty"`
	Path      string `json:"path,omitempty"`
}

type jsonnetFileWriteRequest struct {
	SessionID string `json:"sessionId"`
	Path      string `json:"path,omitempty"`
	Content   string `json:"content"`
	Version   *int   `json:"version,omitempty"`
}

type jsonnetFileReadRequest struct {
	SessionID string `json:"sessionId"`
	Path      string `json:"path,omitempty"`
	Offset    int    `json:"offset,omitempty"`
	Limit     int    `json:"limit,omitempty"`
}

type jsonnetFileEditRequest struct {
	SessionID   string            `json:"sessionId"`
	Path        string            `json:"path,omitempty"`
	BaseVersion *int              `json:"baseVersion,omitempty"`
	Edits       []jsonnetLineEdit `json:"edits"`
}

type jsonnetFileRepairRequest struct {
	SessionID   string `json:"sessionId"`
	Path        string `json:"path,omitempty"`
	BaseVersion *int   `json:"baseVersion,omitempty"`
	Error       string `json:"error,omitempty"`
}

type jsonnetLineEdit struct {
	StartLine    int     `json:"startLine"`
	EndLine      int     `json:"endLine"`
	Replacement  string  `json:"replacement"`
	ExpectedText *string `json:"expectedText,omitempty"`
}

type jsonnetFileResponse struct {
	Path                 string                `json:"path"`
	Version              int                   `json:"version"`
	Checksum             string                `json:"checksum"`
	LineCount            int                   `json:"lineCount"`
	DashboardJsonnet     string                `json:"dashboard_jsonnet,omitempty"`
	DashboardJsonnetSize int                   `json:"dashboardJsonnetSize"`
	UpdatedAt            string                `json:"updatedAt"`
	ChangedRanges        []jsonnetChangedRange `json:"changedRanges,omitempty"`
	Diff                 string                `json:"diff,omitempty"`
	FirstChangedLine     int                   `json:"firstChangedLine,omitempty"`
	TotalLines           int                   `json:"totalLines,omitempty"`
	Lines                []jsonnetFileLine     `json:"lines,omitempty"`
	Repairs              []string              `json:"repairs,omitempty"`
}

type jsonnetChangedRange struct {
	StartLine int `json:"startLine"`
	EndLine   int `json:"endLine"`
	NewLines  int `json:"newLines"`
}

type jsonnetFileLine struct {
	Line int    `json:"line"`
	Text string `json:"text"`
}

type normalizedJsonnetLineEdit struct {
	originalIndex int
	start         int
	end           int
	replacement   []string
	expectedText  *string
}

var jsonnetErrorLinePattern = regexp.MustCompile(`(?m)(?:^|\s)(?:[\w./-]+\.jsonnet):(\d+):`)

func newVirtualJsonnetFileStore() *virtualJsonnetFileStore {
	return &virtualJsonnetFileStore{files: map[string]virtualJsonnetFile{}}
}

func (a *App) handleJsonnetFileWrite(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodPost {
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	var body jsonnetFileWriteRequest
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		writeJSONError(w, http.StatusBadRequest, fmt.Sprintf("invalid request body: %s", err))
		return
	}

	response, err := a.jsonnetFiles.write(body)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, response)
}

func (a *App) handleJsonnetFileEdit(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodPost {
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	var body jsonnetFileEditRequest
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		writeJSONError(w, http.StatusBadRequest, fmt.Sprintf("invalid request body: %s", err))
		return
	}

	response, err := a.jsonnetFiles.edit(body)
	if err != nil {
		status := http.StatusBadRequest
		if errors.Is(err, errVirtualJsonnetConflict) || errors.Is(err, errVirtualJsonnetNotFound) {
			status = http.StatusConflict
		}
		writeJSONError(w, status, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, response)
}

func (a *App) handleJsonnetFileRepair(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodPost {
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	var body jsonnetFileRepairRequest
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		writeJSONError(w, http.StatusBadRequest, fmt.Sprintf("invalid request body: %s", err))
		return
	}

	response, err := a.jsonnetFiles.repair(body)
	if err != nil {
		status := http.StatusBadRequest
		if errors.Is(err, errVirtualJsonnetConflict) || errors.Is(err, errVirtualJsonnetNotFound) {
			status = http.StatusConflict
		}
		writeJSONError(w, status, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, response)
}

func (a *App) handleJsonnetFileRead(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodPost {
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	var body jsonnetFileReadRequest
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		writeJSONError(w, http.StatusBadRequest, fmt.Sprintf("invalid request body: %s", err))
		return
	}

	response, err := a.jsonnetFiles.read(body)
	if err != nil {
		status := http.StatusBadRequest
		if errors.Is(err, errVirtualJsonnetNotFound) {
			status = http.StatusNotFound
		}
		writeJSONError(w, status, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, response)
}

var (
	errVirtualJsonnetNotFound = errors.New("virtual Jsonnet file not found")
	errVirtualJsonnetConflict = errors.New("virtual Jsonnet file version conflict")
)

func (s *virtualJsonnetFileStore) write(request jsonnetFileWriteRequest) (jsonnetFileResponse, error) {
	sessionID, filePath, err := normalizeJsonnetFileRef(jsonnetFileReference{SessionID: request.SessionID, Path: request.Path})
	if err != nil {
		return jsonnetFileResponse{}, err
	}
	if strings.TrimSpace(request.Content) == "" {
		return jsonnetFileResponse{}, errors.New("content is required")
	}
	if len([]byte(request.Content)) > maxManagedDashboardJsonnetSourceBytes {
		return jsonnetFileResponse{}, fmt.Errorf("content is too large: %d bytes exceeds %d bytes", len([]byte(request.Content)), maxManagedDashboardJsonnetSourceBytes)
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	key := virtualJsonnetFileKey(sessionID, filePath)
	version := 1
	if request.Version != nil && *request.Version > 0 {
		version = *request.Version
	} else if existing, ok := s.files[key]; ok {
		version = existing.Version + 1
	}
	file := virtualJsonnetFile{
		SessionID: sessionID,
		Path:      filePath,
		Content:   normalizeSourceLineEndings(request.Content),
		Version:   version,
		UpdatedAt: time.Now().UTC(),
	}
	s.files[key] = file
	return jsonnetFileMutationResponse(file, nil, ""), nil
}

func (s *virtualJsonnetFileStore) read(request jsonnetFileReadRequest) (jsonnetFileResponse, error) {
	sessionID, filePath, err := normalizeJsonnetFileRef(jsonnetFileReference{SessionID: request.SessionID, Path: request.Path})
	if err != nil {
		return jsonnetFileResponse{}, err
	}

	s.mu.Lock()
	file, ok := s.files[virtualJsonnetFileKey(sessionID, filePath)]
	s.mu.Unlock()
	if !ok {
		return jsonnetFileResponse{}, fmt.Errorf("%w: %s", errVirtualJsonnetNotFound, filePath)
	}

	lines, _ := splitJsonnetLines(file.Content)
	offset := request.Offset
	if offset < 1 {
		offset = 1
	}
	limit := request.Limit
	if limit <= 0 || limit > maxJsonnetFileReadLines {
		limit = maxJsonnetFileReadLines
	}
	start := min(max(offset-1, 0), len(lines))
	end := min(start+limit, len(lines))
	response := jsonnetFileMutationResponse(file, nil, "")
	response.TotalLines = len(lines)
	response.Lines = jsonnetFileLines(lines, start, end)
	response.DashboardJsonnet = ""
	return response, nil
}

func (s *virtualJsonnetFileStore) edit(request jsonnetFileEditRequest) (jsonnetFileResponse, error) {
	sessionID, filePath, err := normalizeJsonnetFileRef(jsonnetFileReference{SessionID: request.SessionID, Path: request.Path})
	if err != nil {
		return jsonnetFileResponse{}, err
	}
	if len(request.Edits) == 0 {
		return jsonnetFileResponse{}, errors.New("edits must contain at least one replacement")
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	key := virtualJsonnetFileKey(sessionID, filePath)
	file, ok := s.files[key]
	if !ok {
		return jsonnetFileResponse{}, fmt.Errorf("%w: %s", errVirtualJsonnetNotFound, filePath)
	}
	if request.BaseVersion != nil && *request.BaseVersion != file.Version {
		return jsonnetFileResponse{}, fmt.Errorf("%w: %s is version %d, request used baseVersion %d", errVirtualJsonnetConflict, filePath, file.Version, *request.BaseVersion)
	}

	oldLines, trailingNewline := splitJsonnetLines(file.Content)
	edits, err := normalizeJsonnetEdits(request.Edits, oldLines)
	if err != nil {
		return jsonnetFileResponse{}, err
	}

	newLines := append([]string{}, oldLines...)
	for _, edit := range edits {
		next := make([]string, 0, len(newLines)-(edit.end-edit.start)+len(edit.replacement))
		next = append(next, newLines[:edit.start]...)
		next = append(next, edit.replacement...)
		next = append(next, newLines[edit.end:]...)
		newLines = next
	}

	newContent := joinJsonnetLines(newLines, trailingNewline)
	if newContent == file.Content {
		return jsonnetFileResponse{}, errors.New("edits produced no changes")
	}
	if len([]byte(newContent)) > maxManagedDashboardJsonnetSourceBytes {
		return jsonnetFileResponse{}, fmt.Errorf("edited content is too large: %d bytes exceeds %d bytes", len([]byte(newContent)), maxManagedDashboardJsonnetSourceBytes)
	}
	if _, err := renderJsonnetSource(newContent); err != nil {
		if sourceWindow := sourceWindowForJsonnetError(newContent, err); sourceWindow != "" {
			return jsonnetFileResponse{}, fmt.Errorf("edited Jsonnet did not compile: %w\n%s", err, sourceWindow)
		}
		return jsonnetFileResponse{}, fmt.Errorf("edited Jsonnet did not compile: %w", err)
	}

	changedRanges := make([]jsonnetChangedRange, 0, len(edits))
	for _, edit := range edits {
		changedRanges = append(changedRanges, jsonnetChangedRange{
			StartLine: edit.start + 1,
			EndLine:   edit.end,
			NewLines:  len(edit.replacement),
		})
	}
	sort.Slice(changedRanges, func(i, j int) bool { return changedRanges[i].StartLine < changedRanges[j].StartLine })

	file.Content = newContent
	file.Version++
	file.UpdatedAt = time.Now().UTC()
	s.files[key] = file

	return jsonnetFileMutationResponse(file, changedRanges, jsonnetEditDiff(oldLines, edits)), nil
}

func (s *virtualJsonnetFileStore) repair(request jsonnetFileRepairRequest) (jsonnetFileResponse, error) {
	sessionID, filePath, err := normalizeJsonnetFileRef(jsonnetFileReference{SessionID: request.SessionID, Path: request.Path})
	if err != nil {
		return jsonnetFileResponse{}, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	key := virtualJsonnetFileKey(sessionID, filePath)
	file, ok := s.files[key]
	if !ok {
		return jsonnetFileResponse{}, fmt.Errorf("%w: %s", errVirtualJsonnetNotFound, filePath)
	}
	if request.BaseVersion != nil && *request.BaseVersion != file.Version {
		return jsonnetFileResponse{}, fmt.Errorf("%w: %s is version %d, request used baseVersion %d", errVirtualJsonnetConflict, filePath, file.Version, *request.BaseVersion)
	}

	oldLines, _ := splitJsonnetLines(file.Content)
	newContent, repairs, err := repairJsonnetDashboardSource(file.Content)
	if err != nil {
		return jsonnetFileResponse{}, err
	}
	if newContent == file.Content {
		return jsonnetFileResponse{}, errors.New("no supported Jsonnet repair was found")
	}
	if len([]byte(newContent)) > maxManagedDashboardJsonnetSourceBytes {
		return jsonnetFileResponse{}, fmt.Errorf("repaired content is too large: %d bytes exceeds %d bytes", len([]byte(newContent)), maxManagedDashboardJsonnetSourceBytes)
	}
	if _, err := renderJsonnetSource(newContent); err != nil {
		if sourceWindow := sourceWindowForJsonnetError(newContent, err); sourceWindow != "" {
			return jsonnetFileResponse{}, fmt.Errorf("repaired Jsonnet did not compile: %w\n%s", err, sourceWindow)
		}
		return jsonnetFileResponse{}, fmt.Errorf("repaired Jsonnet did not compile: %w", err)
	}

	newLines, _ := splitJsonnetLines(newContent)
	file.Content = newContent
	file.Version++
	file.UpdatedAt = time.Now().UTC()
	s.files[key] = file

	response := jsonnetFileMutationResponse(file, []jsonnetChangedRange{{
		StartLine: 1,
		EndLine:   len(oldLines),
		NewLines:  len(newLines),
	}}, jsonnetRepairDiffSummary(repairs))
	response.Repairs = repairs
	return response, nil
}

func (s *virtualJsonnetFileStore) get(reference jsonnetFileReference) (virtualJsonnetFile, error) {
	sessionID, filePath, err := normalizeJsonnetFileRef(reference)
	if err != nil {
		return virtualJsonnetFile{}, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	file, ok := s.files[virtualJsonnetFileKey(sessionID, filePath)]
	if !ok {
		return virtualJsonnetFile{}, fmt.Errorf("%w: %s", errVirtualJsonnetNotFound, filePath)
	}
	return file, nil
}

func jsonnetFileMutationResponse(file virtualJsonnetFile, changedRanges []jsonnetChangedRange, diff string) jsonnetFileResponse {
	lines, _ := splitJsonnetLines(file.Content)
	response := jsonnetFileResponse{
		Path:                 file.Path,
		Version:              file.Version,
		Checksum:             checksumBytes([]byte(file.Content)),
		LineCount:            len(lines),
		DashboardJsonnet:     file.Content,
		DashboardJsonnetSize: len([]byte(file.Content)),
		UpdatedAt:            file.UpdatedAt.Format(time.RFC3339Nano),
		ChangedRanges:        changedRanges,
		Diff:                 diff,
	}
	if len(changedRanges) > 0 {
		response.FirstChangedLine = changedRanges[0].StartLine
	}
	return response
}

func normalizeJsonnetFileRef(reference jsonnetFileReference) (string, string, error) {
	sessionID := strings.TrimSpace(reference.SessionID)
	if sessionID == "" {
		return "", "", errors.New("sessionId is required")
	}
	filePath := strings.TrimSpace(reference.Path)
	if filePath == "" {
		filePath = defaultVirtualJsonnetPath
	}
	if strings.Contains(filePath, "\x00") {
		return "", "", errors.New("path is invalid")
	}
	cleaned := path.Clean(strings.ReplaceAll(filePath, "\\", "/"))
	if cleaned == "." || cleaned == "/" || strings.HasPrefix(cleaned, "../") || strings.HasPrefix(cleaned, "/") || strings.Contains(cleaned, "/../") {
		return "", "", errors.New("path must be a relative Jsonnet file path")
	}
	if !strings.HasSuffix(cleaned, ".jsonnet") && !strings.HasSuffix(cleaned, ".libsonnet") {
		return "", "", errors.New("path must end with .jsonnet or .libsonnet")
	}
	return sessionID, cleaned, nil
}

func virtualJsonnetFileKey(sessionID, filePath string) string {
	return sessionID + "\x00" + filePath
}

func normalizeJsonnetEdits(raw []jsonnetLineEdit, lines []string) ([]normalizedJsonnetLineEdit, error) {
	edits := make([]normalizedJsonnetLineEdit, 0, len(raw))
	for index, edit := range raw {
		start := edit.StartLine
		end := edit.EndLine
		if start < 1 {
			return nil, fmt.Errorf("edits[%d].startLine must be at least 1", index)
		}
		if end == 0 {
			end = start - 1
		}
		if end < start-1 {
			return nil, fmt.Errorf("edits[%d].endLine must be greater than or equal to startLine - 1", index)
		}
		if start > len(lines)+1 {
			return nil, fmt.Errorf("edits[%d].startLine is out of range: %d > %d", index, start, len(lines)+1)
		}
		if end > len(lines) {
			return nil, fmt.Errorf("edits[%d].endLine is out of range: %d > %d", index, end, len(lines))
		}
		if edit.ExpectedText != nil {
			actual := strings.Join(lines[start-1:end], "\n")
			if normalizeSourceLineEndings(*edit.ExpectedText) != actual {
				return nil, fmt.Errorf("%w: edits[%d].expectedText did not match lines %d-%d", errVirtualJsonnetConflict, index, start, end)
			}
		}
		edits = append(edits, normalizedJsonnetLineEdit{
			originalIndex: index,
			start:         start - 1,
			end:           end,
			replacement:   replacementLines(edit.Replacement),
			expectedText:  edit.ExpectedText,
		})
	}

	sort.SliceStable(edits, func(i, j int) bool {
		if edits[i].start == edits[j].start {
			return edits[i].end > edits[j].end
		}
		return edits[i].start > edits[j].start
	})
	for index := 1; index < len(edits); index++ {
		later := edits[index-1]
		earlier := edits[index]
		if earlier.end > later.start {
			return nil, fmt.Errorf("edits[%d] and edits[%d] overlap", earlier.originalIndex, later.originalIndex)
		}
	}
	return edits, nil
}

func replacementLines(replacement string) []string {
	normalized := normalizeSourceLineEndings(replacement)
	normalized = strings.TrimSuffix(normalized, "\n")
	if normalized == "" {
		return []string{}
	}
	return strings.Split(normalized, "\n")
}

func splitJsonnetLines(content string) ([]string, bool) {
	normalized := normalizeSourceLineEndings(content)
	trailingNewline := strings.HasSuffix(normalized, "\n")
	trimmed := strings.TrimSuffix(normalized, "\n")
	if trimmed == "" {
		return []string{}, trailingNewline
	}
	return strings.Split(trimmed, "\n"), trailingNewline
}

func joinJsonnetLines(lines []string, trailingNewline bool) string {
	joined := strings.Join(lines, "\n")
	if trailingNewline && joined != "" {
		return joined + "\n"
	}
	return joined
}

func normalizeSourceLineEndings(source string) string {
	return strings.ReplaceAll(strings.ReplaceAll(source, "\r\n", "\n"), "\r", "\n")
}

func jsonnetFileLines(lines []string, start, end int) []jsonnetFileLine {
	result := make([]jsonnetFileLine, 0, max(end-start, 0))
	for index := start; index < end; index++ {
		result = append(result, jsonnetFileLine{Line: index + 1, Text: lines[index]})
	}
	return result
}

func jsonnetEditDiff(oldLines []string, edits []normalizedJsonnetLineEdit) string {
	ordered := append([]normalizedJsonnetLineEdit{}, edits...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].start < ordered[j].start })

	var builder strings.Builder
	for _, edit := range ordered {
		builder.WriteString(jsonnetEditDiffHeader(len(oldLines), edit))
		for _, line := range oldLines[edit.start:edit.end] {
			builder.WriteString("-")
			builder.WriteString(line)
			builder.WriteString("\n")
		}
		for _, line := range edit.replacement {
			builder.WriteString("+")
			builder.WriteString(line)
			builder.WriteString("\n")
		}
	}
	return strings.TrimRight(builder.String(), "\n")
}

func jsonnetEditDiffHeader(oldLineCount int, edit normalizedJsonnetLineEdit) string {
	startLine := edit.start + 1
	if edit.end == edit.start {
		if edit.start >= oldLineCount {
			return fmt.Sprintf("@@ append after line %d @@\n", oldLineCount)
		}
		return fmt.Sprintf("@@ insert before line %d @@\n", startLine)
	}
	return fmt.Sprintf("@@ lines %d-%d @@\n", startLine, edit.end)
}

func jsonnetRepairDiffSummary(repairs []string) string {
	if len(repairs) == 0 {
		return "@@ structural repair @@"
	}
	return "@@ structural repair @@\n" + strings.Join(repairs, "\n")
}

func sourceWindowForJsonnetError(source string, err error) string {
	lineNumber := jsonnetErrorLine(err.Error())
	if lineNumber == 0 {
		return ""
	}
	lines, _ := splitJsonnetLines(source)
	if len(lines) == 0 {
		return ""
	}
	start := max(lineNumber-3, 1)
	end := min(lineNumber+2, len(lines))
	window := jsonnetFileLines(lines, start-1, end)
	rendered := make([]string, 0, len(window)+1)
	rendered = append(rendered, fmt.Sprintf("Source near line %d:", lineNumber))
	for _, line := range window {
		rendered = append(rendered, fmt.Sprintf("%d: %s", line.Line, line.Text))
	}
	return strings.Join(rendered, "\n")
}

func jsonnetErrorLine(message string) int {
	matches := jsonnetErrorLinePattern.FindStringSubmatch(message)
	if len(matches) < 2 {
		return 0
	}
	line, err := strconv.Atoi(matches[1])
	if err != nil {
		return 0
	}
	return line
}
