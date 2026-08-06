import axios from 'axios';

export class CarouselAttachmentValidationError extends Error {
  code = 'CAROUSEL_ATTACHMENT_OUTDATED';
  status = 409;
}

export async function validateCarouselAttachmentForScheduling(post: { attachmentType: string; carouselProjectId?: string | null; carouselPdfUrl?: string | null; carouselAttachmentStatus?: string | null }) {
  if (post.attachmentType !== 'CAROUSEL') return;
  if (!post.carouselProjectId || !post.carouselPdfUrl || post.carouselAttachmentStatus !== 'CURRENT') {
    throw new CarouselAttachmentValidationError('Your carousel has unpublished changes. Update the post attachment before scheduling.');
  }
  try {
    const response = await axios.head(post.carouselPdfUrl, { timeout: 10_000 });
    const contentType = String(response.headers['content-type'] || '').toLowerCase();
    const contentLength = Number(response.headers['content-length'] || 0);
    if (contentType && !contentType.includes('pdf')) throw new Error('Stored attachment is not a PDF.');
    if (contentLength > 100 * 1024 * 1024) throw new Error('Carousel PDF exceeds LinkedIn’s document size limit.');
  } catch (error) {
    if (error instanceof CarouselAttachmentValidationError) throw error;
    throw new CarouselAttachmentValidationError(error instanceof Error ? error.message : 'Carousel PDF is not accessible.');
  }
}
