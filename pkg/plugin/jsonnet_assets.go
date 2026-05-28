package plugin

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"fmt"
	"io/fs"
	"path"
	"strings"

	jsonnet "github.com/google/go-jsonnet"
)

//go:embed jsonnet/templates/*.jsonnet jsonnet/vendor
var jsonnetAssets embed.FS

const (
	jsonnetTemplateRoot = "jsonnet/templates"
	jsonnetVendorRoot   = "jsonnet/vendor"
)

type embeddedJsonnetImporter struct {
	files    fs.FS
	contents map[string]jsonnet.Contents
}

func (i *embeddedJsonnetImporter) Import(importedFrom, importedPath string) (jsonnet.Contents, string, error) {
	candidates := make([]string, 0, 2)
	if importedFrom != "" && !path.IsAbs(importedPath) {
		candidates = append(candidates, path.Clean(path.Join(path.Dir(importedFrom), importedPath)))
	}
	candidates = append(candidates, path.Clean(path.Join(jsonnetVendorRoot, importedPath)))

	for _, candidate := range candidates {
		if !isEmbeddedJsonnetPathAllowed(candidate) {
			continue
		}
		if contents, ok := i.contents[candidate]; ok {
			return contents, candidate, nil
		}
		content, err := fs.ReadFile(i.files, candidate)
		if err == nil {
			contents := jsonnet.MakeContentsRaw(content)
			i.contents[candidate] = contents
			return contents, candidate, nil
		}
	}

	return jsonnet.Contents{}, "", fmt.Errorf("jsonnet import not found: %s", importedPath)
}

func renderJsonnetTemplate(templatePath string, configJSON []byte) ([]byte, error) {
	fullPath := path.Clean(path.Join(jsonnetTemplateRoot, templatePath))
	if !strings.HasPrefix(fullPath, jsonnetTemplateRoot+"/") {
		return nil, fmt.Errorf("invalid template path: %s", templatePath)
	}

	source, err := fs.ReadFile(jsonnetAssets, fullPath)
	if err != nil {
		return nil, err
	}

	vm := jsonnet.MakeVM()
	vm.Importer(&embeddedJsonnetImporter{files: jsonnetAssets, contents: map[string]jsonnet.Contents{}})
	vm.ExtCode("config", string(configJSON))

	rendered, err := vm.EvaluateSnippet(fullPath, string(source))
	if err != nil {
		return nil, err
	}

	return []byte(rendered), nil
}

func jsonnetSourceChecksum(templatePath string, configJSON []byte) (string, error) {
	fullPath := path.Clean(path.Join(jsonnetTemplateRoot, templatePath))
	source, err := fs.ReadFile(jsonnetAssets, fullPath)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(append(source, configJSON...))
	return "sha256:" + hex.EncodeToString(sum[:]), nil
}

func isEmbeddedJsonnetPathAllowed(candidate string) bool {
	if strings.Contains(candidate, "\x00") {
		return false
	}
	cleaned := path.Clean(candidate)
	if cleaned != candidate || strings.HasPrefix(cleaned, "../") || cleaned == ".." {
		return false
	}
	return strings.HasPrefix(cleaned, jsonnetVendorRoot+"/") || strings.HasPrefix(cleaned, jsonnetTemplateRoot+"/")
}
