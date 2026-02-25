import { Router, Request } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { requireAuth } from "../middleware/auth";

const router = Router();

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(process.cwd(), "uploads");
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req: any, file: any, cb: any) => {
    if (file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("Only images are allowed"));
  },
});

interface MulterRequest extends Request {
  file?: Express.Multer.File;
}

router.post("/", requireAuth, upload.single("image"), (req: Request, res: any) => {
  const file = (req as MulterRequest).file;
  if (!file) return res.status(400).json({ error: "No file uploaded" });

  // ✅ leading slash
  const url = `/uploads/${file.filename}`;
  res.json({ url });
});

export default router;