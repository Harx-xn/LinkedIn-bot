import { Router, Request } from "express";
import multer from "multer";
import { requireAuth } from "../middleware/auth";
import { uploadBufferToR2 } from "../middleware/r2";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req: any, file: any, cb: any) => {
    if (file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("Only images are allowed"));
  },
});

interface MulterRequest extends Request {
  file?: Express.Multer.File;
}

router.post("/", requireAuth, upload.single("image"), async (req: Request, res: any) => {
  const file = (req as MulterRequest).file;
  if (!file) return res.status(400).json({ error: "No file uploaded" });

  const ext = file.originalname.split(".").pop() || "jpg";
  const key = `uploads/${Date.now()}-${Math.round(Math.random() * 1e9)}.${ext}`;

  const url = await uploadBufferToR2(file.buffer, key, file.mimetype);

  res.json({ url });
});

export default router;