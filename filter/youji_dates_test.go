package filter

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestYoujiEventDateCalendarRendering(t *testing.T) {
	engine, err := NewEngine(NewSchema())
	require.NoError(t, err)
	for _, dialect := range []DialectName{DialectSQLite, DialectMySQL, DialectPostgres} {
		for _, query := range []string{`event_date >= "2024-02-29" && event_date <= "2026-11-19"`, `event_date == ""`} {
			stmt, err := engine.CompileToStatement(context.Background(), query, RenderOptions{Dialect: dialect})
			require.NoError(t, err)
			require.Contains(t, stmt.SQL, "COALESCE(")
			require.Contains(t, stmt.SQL, "event_date")
			require.NotContains(t, stmt.SQL, "timestamp(")
		}
	}
}
