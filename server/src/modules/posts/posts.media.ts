import type { PostImage, PostVideo } from '../../contract/posts';
import { uploadBufferToS3, uploadVideoBufferToS3, deleteFromS3 } from '../../config/s3';

export interface UploadedMedia {
  images: PostImage[];
  video: PostVideo | null;
  urls: string[];
}

export async function uploadPostMedia(
  imageBuffers: Buffer[],
  videoBuffer: Buffer | null,
): Promise<UploadedMedia> {
  const images: PostImage[] = [];
  const urls: string[] = [];

  try {
    for (const buffer of imageBuffers) {
      const uploaded = await uploadBufferToS3(buffer, 'posts');
      images.push({ url: uploaded.url, width: uploaded.width, height: uploaded.height });
      urls.push(uploaded.url);
    }

    let video: PostVideo | null = null;
    if (videoBuffer) {
      const uploaded = await uploadVideoBufferToS3(videoBuffer, 'posts');
      video = { url: uploaded.url, width: uploaded.width, height: uploaded.height };
      urls.push(uploaded.url);
    }

    return { images, video, urls };
  } catch (err) {
    await cleanupUploadedMedia(urls);
    throw err;
  }
}

export async function cleanupUploadedMedia(urls: string[]): Promise<void> {
  if (urls.length === 0) return;
  await Promise.all(urls.map((url) => deleteFromS3(url)));
}
