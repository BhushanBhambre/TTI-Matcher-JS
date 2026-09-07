/**
 * streamReader.js
 * ---------------------------------------------------------------------------
 * High-performance chunked file reader for large files (1M+ rows, 500MB+).
 * Uses FileReader.readAsArrayBuffer or File.stream() with TextDecoder stream
 * decoding so multi-gigabyte files are read without hitting V8 string limits.
 * ---------------------------------------------------------------------------
 */

(function (global) {
  const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB byte chunks

  /**
   * Stream a File line-by-line in batches.
   *
   * @param {File} file - The file to read.
   * @param {Object} options
   * @param {(lines: string[], bytesRead: number, totalBytes: number) => void} options.onChunk - Called per line batch
   * @param {number} [options.chunkSize] - Custom chunk size in bytes
   * @returns {Promise<{totalLines: number, totalBytes: number}>}
   */
  async function streamFile(file, options = {}) {
    const chunkSize = options.chunkSize || CHUNK_SIZE;
    const totalBytes = file.size;
    let offset = 0;
    let remainder = "";
    let totalLines = 0;
    const decoder = new TextDecoder("utf-8");

    if (typeof file.stream === "function") {
      const reader = file.stream().getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        offset += value.byteLength;
        const text = decoder.decode(value, { stream: true });
        const combined = remainder + text;
        const lines = combined.split(/\r\n|\n|\r/);
        remainder = lines.pop() || "";

        if (lines.length > 0) {
          totalLines += lines.length;
          if (options.onChunk) {
            await options.onChunk(lines, offset, totalBytes);
          }
        }
      }
    } else {
      while (offset < totalBytes) {
        const end = Math.min(offset + chunkSize, totalBytes);
        const blobSlice = file.slice(offset, end);
        const buffer = await readSliceAsBuffer(blobSlice);

        offset = end;
        const isLastSlice = offset >= totalBytes;
        const text = decoder.decode(buffer, { stream: !isLastSlice });
        const combined = remainder + text;
        const lines = combined.split(/\r\n|\n|\r/);
        remainder = lines.pop() || "";

        if (lines.length > 0) {
          totalLines += lines.length;
          if (options.onChunk) {
            await options.onChunk(lines, offset, totalBytes);
          }
        }
      }
    }

    const finalLeftover = remainder + decoder.decode();
    if (finalLeftover.length > 0) {
      totalLines++;
      if (options.onChunk) {
        await options.onChunk([finalLeftover], totalBytes, totalBytes);
      }
    }

    return { totalLines, totalBytes };
  }

  function readSliceAsBuffer(blobSlice) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(blobSlice);
    });
  }

  global.streamReader = { streamFile };
})(typeof window !== "undefined" ? window : this);
