"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("express-async-errors");
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const config_1 = require("./config");
const auth_1 = __importDefault(require("./routes/auth"));
const linkedin_1 = __importDefault(require("./routes/linkedin"));
const sheets_1 = __importDefault(require("./routes/sheets"));
const posts_1 = __importDefault(require("./routes/posts"));
const user_1 = __importDefault(require("./routes/user"));
const schedulerService_1 = require("./services/schedulerService");
const app = (0, express_1.default)();
app.use((0, cors_1.default)());
app.use(express_1.default.json());
app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
});
app.use('/api/auth', auth_1.default);
app.use('/api/linkedin', linkedin_1.default);
app.use('/api/sheets', sheets_1.default);
app.use('/api/posts', posts_1.default);
app.use('/api/user', user_1.default);
app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
});
app.listen(config_1.config.port, () => {
    console.log(`Backend running on http://localhost:${config_1.config.port}`);
    (0, schedulerService_1.startScheduler)();
});
