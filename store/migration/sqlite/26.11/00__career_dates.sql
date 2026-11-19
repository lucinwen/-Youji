ALTER TABLE memo ADD COLUMN event_date VARCHAR(10) DEFAULT NULL;
ALTER TABLE memo ADD COLUMN captured_ts BIGINT DEFAULT NULL;
CREATE INDEX idx_memo_event_date ON memo(creator_id, event_date, row_status);
