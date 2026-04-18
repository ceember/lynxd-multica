package service

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"
)

func TestSyncTaskToSupabase_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(201)
	}))
	defer srv.Close()

	os.Setenv("SUPABASE_URL", srv.URL)
	os.Setenv("SUPABASE_SERVICE_KEY", "test-key")
	defer os.Unsetenv("SUPABASE_URL")
	defer os.Unsetenv("SUPABASE_SERVICE_KEY")

	SyncTaskToSupabase(context.Background(), SupabaseTaskRow{
		TaskID: "test-1", Agent: "content-writer", Status: "pending",
	})

	// Fire-and-forget: give the goroutine time to complete.
	time.Sleep(100 * time.Millisecond)
}

func TestSyncTaskToSupabase_ServerError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(500)
	}))
	defer srv.Close()

	os.Setenv("SUPABASE_URL", srv.URL)
	os.Setenv("SUPABASE_SERVICE_KEY", "test-key")
	defer os.Unsetenv("SUPABASE_URL")
	defer os.Unsetenv("SUPABASE_SERVICE_KEY")

	// Must not panic on 500.
	SyncTaskToSupabase(context.Background(), SupabaseTaskRow{
		TaskID: "test-2", Agent: "content-writer", Status: "pending",
	})

	time.Sleep(100 * time.Millisecond)
}

func TestSyncTaskToSupabase_MissingEnv(t *testing.T) {
	os.Unsetenv("SUPABASE_URL")
	os.Unsetenv("SUPABASE_SERVICE_KEY")

	// Must not panic or block when env vars are missing.
	SyncTaskToSupabase(context.Background(), SupabaseTaskRow{
		TaskID: "test-3", Agent: "content-writer", Status: "pending",
	})

	time.Sleep(50 * time.Millisecond)
}
