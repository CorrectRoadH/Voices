ALTER TABLE users ADD COLUMN ui_language text NOT NULL DEFAULT 'zh-CN'
    CHECK (ui_language IN ('zh-CN', 'en'));
