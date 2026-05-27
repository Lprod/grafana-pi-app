package plugin

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"path"
	"sort"
	"strings"
)

type jsonnetLibSearchRequest struct {
	Pattern string `json:"pattern"`
	Path    string `json:"path,omitempty"`
}

type jsonnetLibReadRequest struct {
	Path   string `json:"path"`
	Offset int    `json:"offset,omitempty"`
	Limit  int    `json:"limit,omitempty"`
}

type jsonnetLibListRequest struct {
	Path string `json:"path,omitempty"`
}

type jsonnetLibMatch struct {
	File string `json:"file"`
	Line int    `json:"line"`
	Text string `json:"text"`
}

var allowedJsonnetLibPrefixes = []string{
	"github.com/grafana/grafonnet/",
	"github.com/jsonnet-libs/xtd/",
	"github.com/jsonnet-libs/docsonnet/",
}

func (a *App) handleJsonnetLibSearch(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodPost {
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	var body jsonnetLibSearchRequest
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		writeJSONError(w, http.StatusBadRequest, fmt.Sprintf("invalid request body: %s", err))
		return
	}
	body.Pattern = strings.TrimSpace(body.Pattern)
	if len(body.Pattern) < 2 {
		writeJSONError(w, http.StatusBadRequest, "pattern must be at least 2 characters")
		return
	}
	if len(body.Pattern) > 100 {
		writeJSONError(w, http.StatusBadRequest, "pattern too long")
		return
	}

	searchPath := body.Path
	if searchPath == "" {
		searchPath = "github.com/grafana/grafonnet"
	}
	root, err := safeJsonnetLibPath(searchPath)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}

	needle := strings.ToLower(body.Pattern)
	matches := []jsonnetLibMatch{}
	const maxResults = 100
	_ = fs.WalkDir(jsonnetAssets, root, func(filePath string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() || len(matches) >= maxResults || !jsonnetLibSearchable(entry.Name()) {
			return nil
		}
		content, err := fs.ReadFile(jsonnetAssets, filePath)
		if err != nil {
			return nil
		}
		relFile := strings.TrimPrefix(filePath, jsonnetVendorRoot+"/")
		for index, line := range strings.Split(string(content), "\n") {
			if len(matches) >= maxResults {
				return nil
			}
			if strings.Contains(strings.ToLower(line), needle) {
				matches = append(matches, jsonnetLibMatch{File: relFile, Line: index + 1, Text: strings.TrimRight(line, "\r")})
			}
		}
		return nil
	})

	writeJSON(w, http.StatusOK, map[string]any{
		"result": matches,
		"total":  len(matches),
		"capped": len(matches) >= maxResults,
	})
}

func (a *App) handleJsonnetLibRead(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodPost {
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	var body jsonnetLibReadRequest
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		writeJSONError(w, http.StatusBadRequest, fmt.Sprintf("invalid request body: %s", err))
		return
	}
	filePath, err := safeJsonnetLibPath(body.Path)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	content, err := fs.ReadFile(jsonnetAssets, filePath)
	if err != nil {
		writeJSONError(w, http.StatusNotFound, "file not found")
		return
	}

	lines := strings.Split(string(content), "\n")
	offset := body.Offset
	if offset < 1 {
		offset = 1
	}
	limit := body.Limit
	if limit < 1 {
		limit = 200
	}
	if limit > 500 {
		limit = 500
	}

	result := make([]map[string]any, 0, limit)
	for index := offset - 1; index < len(lines) && len(result) < limit; index++ {
		result = append(result, map[string]any{"line": index + 1, "text": strings.TrimRight(lines[index], "\r")})
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"path":       body.Path,
		"totalLines": len(lines),
		"result":     result,
	})
}

func (a *App) handleJsonnetLibList(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodPost {
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	var body jsonnetLibListRequest
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		writeJSONError(w, http.StatusBadRequest, fmt.Sprintf("invalid request body: %s", err))
		return
	}
	listPath := body.Path
	if listPath == "" {
		listPath = "github.com/grafana/grafonnet/gen/grafonnet-v11.4.0"
	}
	root, err := safeJsonnetLibPath(listPath)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}

	files := []string{}
	_ = fs.WalkDir(jsonnetAssets, root, func(filePath string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() || !strings.HasSuffix(entry.Name(), ".libsonnet") {
			return nil
		}
		files = append(files, strings.TrimPrefix(filePath, root+"/"))
		return nil
	})
	sort.Strings(files)

	writeJSON(w, http.StatusOK, map[string]any{"basePath": listPath, "result": files})
}

func jsonnetLibSearchable(name string) bool {
	return strings.HasSuffix(name, ".libsonnet") || strings.HasSuffix(name, ".md")
}

func safeJsonnetLibPath(relPath string) (string, error) {
	relPath = strings.TrimSpace(relPath)
	if relPath == "" {
		return "", fmt.Errorf("path is required")
	}
	cleaned := path.Clean(relPath)
	if cleaned != relPath || strings.HasPrefix(cleaned, "../") || strings.HasPrefix(cleaned, "/") || cleaned == ".." {
		return "", fmt.Errorf("path not allowed")
	}
	if !jsonnetLibPrefixAllowed(cleaned) {
		return "", fmt.Errorf("path not allowed. Must be under: %s", strings.Join(allowedJsonnetLibPrefixes, ", "))
	}
	return path.Join(jsonnetVendorRoot, cleaned), nil
}

func jsonnetLibPrefixAllowed(relPath string) bool {
	for _, allowed := range allowedJsonnetLibPrefixes {
		prefix := strings.TrimSuffix(allowed, "/")
		if relPath == prefix || strings.HasPrefix(relPath, allowed) || strings.HasPrefix(allowed, relPath+"/") {
			return true
		}
	}
	return false
}
