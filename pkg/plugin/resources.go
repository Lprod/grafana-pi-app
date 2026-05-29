package plugin

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
)

type proxyStreamRequest struct {
	Model   proxyModel   `json:"model"`
	Context proxyContext `json:"context"`
	Options proxyOptions `json:"options"`
}

type proxyModel struct {
	ID string `json:"id"`
}

type proxyOptions struct {
	Temperature *float64 `json:"temperature,omitempty"`
	MaxTokens   *int     `json:"maxTokens,omitempty"`
}

type proxyContext struct {
	SystemPrompt string         `json:"systemPrompt,omitempty"`
	Messages     []proxyMessage `json:"messages"`
	Tools        []proxyTool    `json:"tools,omitempty"`
}

type proxyMessage struct {
	Role       string          `json:"role"`
	Content    json.RawMessage `json:"content"`
	ToolCallID string          `json:"toolCallId,omitempty"`
	ToolName   string          `json:"toolName,omitempty"`
}

type proxyTool struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Parameters  json.RawMessage `json:"parameters"`
}

type openAIChatRequest struct {
	Model         string          `json:"model"`
	Messages      []openAIMessage `json:"messages"`
	Tools         []openAITool    `json:"tools,omitempty"`
	Stream        bool            `json:"stream"`
	StreamOptions map[string]bool `json:"stream_options,omitempty"`
	Temperature   *float64        `json:"temperature,omitempty"`
	MaxTokens     *int            `json:"max_tokens,omitempty"`
}

type openAIMessage struct {
	Role       string           `json:"role"`
	Content    string           `json:"content,omitempty"`
	ToolCalls  []openAIToolCall `json:"tool_calls,omitempty"`
	ToolCallID string           `json:"tool_call_id,omitempty"`
	Name       string           `json:"name,omitempty"`
}

type openAITool struct {
	Type     string         `json:"type"`
	Function openAIFunction `json:"function"`
}

type openAIFunction struct {
	Name        string          `json:"name"`
	Description string          `json:"description,omitempty"`
	Parameters  json.RawMessage `json:"parameters"`
}

type openAIToolCall struct {
	ID       string             `json:"id"`
	Type     string             `json:"type"`
	Function openAIToolFunction `json:"function"`
}

type openAIToolFunction struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

type openAIStreamChunk struct {
	Choices []struct {
		Delta struct {
			Content   string `json:"content"`
			ToolCalls []struct {
				Index    int    `json:"index"`
				ID       string `json:"id"`
				Type     string `json:"type"`
				Function struct {
					Name      string `json:"name"`
					Arguments string `json:"arguments"`
				} `json:"function"`
			} `json:"tool_calls"`
		} `json:"delta"`
		FinishReason string `json:"finish_reason"`
	} `json:"choices"`
	Usage *openAIUsage `json:"usage,omitempty"`
}

type openAIUsage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	TotalTokens      int `json:"total_tokens"`
}

type proxyUsage struct {
	Input       int            `json:"input"`
	Output      int            `json:"output"`
	CacheRead   int            `json:"cacheRead"`
	CacheWrite  int            `json:"cacheWrite"`
	TotalTokens int            `json:"totalTokens"`
	Cost        map[string]int `json:"cost"`
}

type streamedToolCall struct {
	contentIndex int
	started      bool
	id           string
	name         string
	arguments    strings.Builder
}

var errOpenAIStreamDone = errors.New("openai stream done")

func (a *App) handleLLMStream(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodPost {
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if a.settings.OpenAIAPIKey == "" {
		writeJSONError(w, http.StatusBadRequest, "OpenAI-compatible API key is not configured")
		return
	}

	var body proxyStreamRequest
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		writeJSONError(w, http.StatusBadRequest, fmt.Sprintf("invalid request body: %s", err))
		return
	}

	upstreamBody, err := json.Marshal(a.openAIRequest(body))
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}

	upstreamReq, err := http.NewRequestWithContext(req.Context(), http.MethodPost, a.settings.OpenAIBaseURL+"/chat/completions", bytes.NewReader(upstreamBody))
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	upstreamReq.Header.Set("Authorization", "Bearer "+a.settings.OpenAIAPIKey)
	upstreamReq.Header.Set("Content-Type", "application/json")
	upstreamReq.Header.Set("Accept", "text/event-stream")

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)

	stream := newProxyEventWriter(w, flusher)
	if err := stream.write(map[string]interface{}{"type": "start"}); err != nil {
		return
	}

	upstreamRes, err := a.httpClient.Do(upstreamReq)
	if err != nil {
		_ = stream.write(errorEvent(err.Error()))
		return
	}
	defer func() {
		_ = upstreamRes.Body.Close()
	}()

	if upstreamRes.StatusCode < 200 || upstreamRes.StatusCode >= 300 {
		message, _ := io.ReadAll(io.LimitReader(upstreamRes.Body, 32_768))
		_ = stream.write(errorEvent(string(message)))
		return
	}

	if err := a.relayOpenAIStream(upstreamRes.Body, stream); err != nil {
		_ = stream.write(errorEvent(err.Error()))
	}
}

func (a *App) openAIRequest(req proxyStreamRequest) openAIChatRequest {
	model := a.settings.DefaultModel

	messages := make([]openAIMessage, 0, len(req.Context.Messages)+1)
	if req.Context.SystemPrompt != "" {
		messages = append(messages, openAIMessage{
			Role:    "system",
			Content: req.Context.SystemPrompt,
		})
	}
	for _, message := range req.Context.Messages {
		converted := convertMessage(message)
		if converted.Role != "" {
			messages = append(messages, converted)
		}
	}

	tools := make([]openAITool, 0, len(req.Context.Tools))
	for _, tool := range req.Context.Tools {
		tools = append(tools, openAITool{
			Type:     "function",
			Function: openAIFunction(tool),
		})
	}

	return openAIChatRequest{
		Model:         model,
		Messages:      messages,
		Tools:         tools,
		Stream:        true,
		StreamOptions: map[string]bool{"include_usage": true},
		Temperature:   req.Options.Temperature,
		MaxTokens:     req.Options.MaxTokens,
	}
}

func (a *App) relayOpenAIStream(body io.Reader, stream proxyEventWriter) error {
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)

	nextContentIndex := 0
	textStarted := false
	textIndex := -1
	toolCalls := map[int]*streamedToolCall{}
	usage := zeroUsage()
	doneReason := "stop"
	dataLines := make([]string, 0, 4)

	processData := func(data string) error {
		data = strings.TrimSpace(data)
		if data == "" {
			return nil
		}
		if data == "[DONE]" {
			return errOpenAIStreamDone
		}

		var chunk openAIStreamChunk
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			return fmt.Errorf("invalid upstream stream chunk: %w", err)
		}
		if chunk.Usage != nil {
			usage = usageFromOpenAI(chunk.Usage)
		}

		for _, choice := range chunk.Choices {
			if choice.FinishReason == "length" {
				doneReason = "length"
			}
			if choice.FinishReason == "tool_calls" {
				doneReason = "toolUse"
			}

			if choice.Delta.Content != "" {
				if !textStarted {
					textStarted = true
					textIndex = nextContentIndex
					nextContentIndex++
					if err := stream.write(map[string]interface{}{"type": "text_start", "contentIndex": textIndex}); err != nil {
						return err
					}
				}
				if err := stream.write(map[string]interface{}{"type": "text_delta", "contentIndex": textIndex, "delta": choice.Delta.Content}); err != nil {
					return err
				}
			}

			for _, delta := range choice.Delta.ToolCalls {
				state := toolCalls[delta.Index]
				if state == nil {
					state = &streamedToolCall{contentIndex: nextContentIndex}
					nextContentIndex++
					toolCalls[delta.Index] = state
				}
				if delta.ID != "" {
					state.id = delta.ID
				}
				if delta.Function.Name != "" {
					state.name = delta.Function.Name
				}
				if !state.started && state.name != "" {
					state.started = true
					if state.id == "" {
						state.id = fmt.Sprintf("call_%d", delta.Index)
					}
					if err := stream.write(map[string]interface{}{
						"type":         "toolcall_start",
						"contentIndex": state.contentIndex,
						"id":           state.id,
						"toolName":     state.name,
					}); err != nil {
						return err
					}
					if state.arguments.Len() > 0 {
						if err := stream.write(map[string]interface{}{
							"type":         "toolcall_delta",
							"contentIndex": state.contentIndex,
							"delta":        state.arguments.String(),
						}); err != nil {
							return err
						}
					}
					doneReason = "toolUse"
				}
				if delta.Function.Arguments != "" {
					state.arguments.WriteString(delta.Function.Arguments)
					if state.started {
						if err := stream.write(map[string]interface{}{
							"type":         "toolcall_delta",
							"contentIndex": state.contentIndex,
							"delta":        delta.Function.Arguments,
						}); err != nil {
							return err
						}
					}
				}
			}
		}
		return nil
	}

	flushData := func() error {
		if len(dataLines) == 0 {
			return nil
		}
		data := strings.Join(dataLines, "\n")
		dataLines = dataLines[:0]
		return processData(data)
	}

	for scanner.Scan() {
		line := strings.TrimRight(scanner.Text(), "\r")
		if line == "" {
			if err := flushData(); err != nil {
				if errors.Is(err, errOpenAIStreamDone) {
					break
				}
				return err
			}
			continue
		}
		if strings.HasPrefix(line, ":") {
			continue
		}
		if data, ok := strings.CutPrefix(line, "data:"); ok {
			dataLines = append(dataLines, strings.TrimPrefix(data, " "))
		}
	}

	if err := scanner.Err(); err != nil {
		return err
	}
	if err := flushData(); err != nil && !errors.Is(err, errOpenAIStreamDone) {
		return err
	}
	if textStarted {
		if err := stream.write(map[string]interface{}{"type": "text_end", "contentIndex": textIndex}); err != nil {
			return err
		}
	}
	toolCallIndexes := make([]int, 0, len(toolCalls))
	for index := range toolCalls {
		toolCallIndexes = append(toolCallIndexes, index)
	}
	sort.Ints(toolCallIndexes)
	for _, index := range toolCallIndexes {
		state := toolCalls[index]
		if !state.started {
			return errors.New("upstream returned a tool call without a function name")
		}
		if err := stream.write(map[string]interface{}{"type": "toolcall_end", "contentIndex": state.contentIndex}); err != nil {
			return err
		}
	}

	return stream.write(map[string]interface{}{"type": "done", "reason": doneReason, "usage": usage})
}

func convertMessage(message proxyMessage) openAIMessage {
	switch message.Role {
	case "user":
		return openAIMessage{Role: "user", Content: nonEmptyContent(message.Content, " ")}
	case "assistant":
		text, toolCalls := assistantContent(message.Content)
		return openAIMessage{Role: "assistant", Content: text, ToolCalls: toolCalls}
	case "toolResult":
		return openAIMessage{
			Role:       "tool",
			ToolCallID: message.ToolCallID,
			Name:       message.ToolName,
			Content:    nonEmptyContent(message.Content, "(empty tool result)"),
		}
	default:
		return openAIMessage{}
	}
}

func nonEmptyContent(raw json.RawMessage, fallback string) string {
	text := contentText(raw)
	if strings.TrimSpace(text) == "" {
		return fallback
	}
	return text
}

func contentText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var text string
	if err := json.Unmarshal(raw, &text); err == nil {
		return text
	}

	var blocks []map[string]interface{}
	if err := json.Unmarshal(raw, &blocks); err != nil {
		return string(raw)
	}

	parts := make([]string, 0, len(blocks))
	for _, block := range blocks {
		if block["type"] == "text" {
			if value, ok := block["text"].(string); ok {
				parts = append(parts, value)
			}
		}
	}
	return strings.Join(parts, "\n")
}

func assistantContent(raw json.RawMessage) (string, []openAIToolCall) {
	if len(raw) == 0 {
		return "", nil
	}

	var blocks []map[string]interface{}
	if err := json.Unmarshal(raw, &blocks); err != nil {
		return contentText(raw), nil
	}

	textParts := make([]string, 0, len(blocks))
	toolCalls := make([]openAIToolCall, 0)
	for _, block := range blocks {
		switch block["type"] {
		case "text":
			if value, ok := block["text"].(string); ok {
				textParts = append(textParts, value)
			}
		case "toolCall":
			name, _ := block["name"].(string)
			id, _ := block["id"].(string)
			args, _ := json.Marshal(block["arguments"])
			toolCalls = append(toolCalls, openAIToolCall{
				ID:   id,
				Type: "function",
				Function: openAIToolFunction{
					Name:      name,
					Arguments: string(args),
				},
			})
		}
	}
	return strings.Join(textParts, "\n"), toolCalls
}

type proxyEventWriter struct {
	w       http.ResponseWriter
	flusher http.Flusher
}

func newProxyEventWriter(w http.ResponseWriter, flusher http.Flusher) proxyEventWriter {
	return proxyEventWriter{w: w, flusher: flusher}
}

func (w proxyEventWriter) write(event map[string]interface{}) error {
	data, err := json.Marshal(event)
	if err != nil {
		return err
	}
	if _, err := fmt.Fprintf(w.w, "data: %s\n\n", data); err != nil {
		return err
	}
	if w.flusher != nil {
		w.flusher.Flush()
	}
	return nil
}

func usageFromOpenAI(usage *openAIUsage) proxyUsage {
	return proxyUsage{
		Input:       usage.PromptTokens,
		Output:      usage.CompletionTokens,
		CacheRead:   0,
		CacheWrite:  0,
		TotalTokens: usage.TotalTokens,
		Cost:        zeroCost(),
	}
}

func zeroUsage() proxyUsage {
	return proxyUsage{
		Input:       0,
		Output:      0,
		CacheRead:   0,
		CacheWrite:  0,
		TotalTokens: 0,
		Cost:        zeroCost(),
	}
}

func zeroCost() map[string]int {
	return map[string]int{
		"input":      0,
		"output":     0,
		"cacheRead":  0,
		"cacheWrite": 0,
		"total":      0,
	}
}

func errorEvent(message string) map[string]interface{} {
	return map[string]interface{}{
		"type":         "error",
		"reason":       "error",
		"errorMessage": message,
		"usage":        zeroUsage(),
	}
}

func writeJSONError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": strings.TrimSpace(message)})
}

// registerRoutes takes a *http.ServeMux and registers HTTP handlers.
func (a *App) registerRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/llm/stream", a.handleLLMStream)
	// streamProxy appends /api/stream to proxyUrl; keep this alias so the frontend
	// can use Pi's client-side proxy stream implementation unchanged.
	mux.HandleFunc("/llm/api/stream", a.handleLLMStream)
	mux.HandleFunc("/managed-dashboards", a.handleManagedDashboardList)
	mux.HandleFunc("/managed-dashboards/source", a.handleManagedDashboardSource)
	mux.HandleFunc("/managed-dashboards/render", a.handleManagedDashboardRender)
	mux.HandleFunc("/managed-dashboards/sync", a.handleManagedDashboardSync)
	mux.HandleFunc("/managed-dashboards/jsonnet-files/write", a.handleJsonnetFileWrite)
	mux.HandleFunc("/managed-dashboards/jsonnet-files/edit", a.handleJsonnetFileEdit)
	mux.HandleFunc("/managed-dashboards/jsonnet-files/repair", a.handleJsonnetFileRepair)
	mux.HandleFunc("/managed-dashboards/jsonnet-files/read", a.handleJsonnetFileRead)
	mux.HandleFunc("/jsonnet-libs/search", a.handleJsonnetLibSearch)
	mux.HandleFunc("/jsonnet-libs/read", a.handleJsonnetLibRead)
	mux.HandleFunc("/jsonnet-libs/list", a.handleJsonnetLibList)
}
