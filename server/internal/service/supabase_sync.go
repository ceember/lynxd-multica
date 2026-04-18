package service

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// SupabaseTaskRow mirrors the lynxd_agent_tasks schema (Session 18 migration).
// Fields use omitempty so an empty row does not clobber columns on upsert.
type SupabaseTaskRow struct {
	TaskID         string                 `json:"task_id"`
	Agent          string                 `json:"agent"`
	Status         string                 `json:"status"`
	Priority       string                 `json:"priority,omitempty"`
	Input          string                 `json:"input,omitempty"`
	Output         string                 `json:"output,omitempty"`
	ApprovalStatus string                 `json:"approval_status,omitempty"`
	Metadata       map[string]interface{} `json:"metadata,omitempty"`
}

// SyncTaskToSupabase mirrors one task row to lynxd_agent_tasks.
// Fire-and-forget: launches a goroutine, returns immediately, never blocks
// the caller. 5s HTTP timeout. Upsert via resolution=merge-duplicates so
// repeated calls for the same task_id update instead of erroring.
// Failure logs and returns; the local Multica DB write is authoritative.
func SyncTaskToSupabase(ctx context.Context, task SupabaseTaskRow) {
	go func() {
		url := os.Getenv("SUPABASE_URL")
		key := os.Getenv("SUPABASE_SERVICE_KEY")
		if url == "" || key == "" {
			slog.Info("[supabase-sync] skipped: env vars missing", "task_id", task.TaskID)
			return
		}

		body, err := json.Marshal(task)
		if err != nil {
			slog.Error("[supabase-sync] marshal failed", "task_id", task.TaskID, "error", err)
			return
		}

		reqCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()

		req, err := http.NewRequestWithContext(reqCtx, "POST",
			fmt.Sprintf("%s/rest/v1/lynxd_agent_tasks", url),
			bytes.NewBuffer(body))
		if err != nil {
			slog.Error("[supabase-sync] request build failed", "task_id", task.TaskID, "error", err)
			return
		}
		req.Header.Set("apikey", key)
		req.Header.Set("Authorization", "Bearer "+key)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Prefer", "resolution=merge-duplicates")

		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			slog.Error("[supabase-sync] network error", "task_id", task.TaskID, "error", err)
			return
		}
		defer resp.Body.Close()

		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			slog.Info("[supabase-sync] synced", "task_id", task.TaskID, "http", resp.StatusCode)
		} else {
			slog.Error("[supabase-sync] non-2xx response", "task_id", task.TaskID, "http", resp.StatusCode)
		}
	}()
}

// syncAgentTask is a thin convenience used by TaskService enqueue paths.
// It maps the Multica db.AgentTaskQueue row to the SupabaseTaskRow shape
// (notably: int32 priority -> text, pgtype UUIDs -> strings) and fires
// SyncTaskToSupabase. Keeping the mapping here keeps task.go touches minimal.
func syncAgentTask(ctx context.Context, task db.AgentTaskQueue) {
	row := SupabaseTaskRow{
		TaskID:         util.UUIDToString(task.ID),
		Agent:          util.UUIDToString(task.AgentID),
		Status:         task.Status,
		Priority:       priorityIntToString(task.Priority),
		ApprovalStatus: "auto",
		Metadata: map[string]interface{}{
			"source": "multica-server",
		},
	}
	if task.IssueID.Valid {
		row.Metadata["issue_id"] = util.UUIDToString(task.IssueID)
	}
	if task.RuntimeID.Valid {
		row.Metadata["runtime_id"] = util.UUIDToString(task.RuntimeID)
	}
	if task.ChatSessionID.Valid {
		row.Metadata["chat_session_id"] = util.UUIDToString(task.ChatSessionID)
	}
	if task.AutopilotRunID.Valid {
		row.Metadata["autopilot_run_id"] = util.UUIDToString(task.AutopilotRunID)
	}
	if task.TriggerCommentID.Valid {
		row.Metadata["trigger_comment_id"] = util.UUIDToString(task.TriggerCommentID)
	}
	SyncTaskToSupabase(ctx, row)
}

// priorityIntToString inverts priorityToInt (task.go) for the Supabase row.
// Returns "" for the unknown/default value so omitempty drops it on the wire.
func priorityIntToString(p int32) string {
	switch p {
	case 4:
		return "urgent"
	case 3:
		return "high"
	case 2:
		return "medium"
	case 1:
		return "low"
	default:
		return ""
	}
}
