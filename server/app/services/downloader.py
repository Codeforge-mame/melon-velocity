import os
import time
import asyncio
import aiohttp
from fastapi import HTTPException
from app.core.config import settings

class SegmentedDownloaderService:
    @staticmethod
    async def _download_chunk(session: aiohttp.ClientSession, url: str, start: int, end: int, chunk_id: int, task_temp_dir: str) -> str:
        headers = {
            "Range": f"bytes={start}-{end}",
            "Connection": "keep-alive",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
        }
        chunk_path = os.path.join(task_temp_dir, f"part_{chunk_id}.tmp")
        
        async with session.get(url, headers=headers) as response:
            if response.status not in (200, 206):
                raise HTTPException(status_code=500, detail=f"Chunk worker {chunk_id} rejected stream data (status {response.status}).")
            with open(chunk_path, "wb") as f:
                async for chunk in response.content.iter_chunked(64 * 1024):
                    f.write(chunk)
        return chunk_path

    @classmethod
    async def _download_single_stream(cls, session: aiohttp.ClientSession, url: str, output_path: str):
        headers = {
            "Connection": "keep-alive",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
        }
        async with session.get(url, headers=headers) as response:
            if response.status != 200:
                raise HTTPException(status_code=500, detail=f"Direct stream download failed with status {response.status}.")
            with open(output_path, "wb") as f:
                async for chunk in response.content.iter_chunked(64 * 1024):
                    f.write(chunk)

    @classmethod
    async def execute_parallel_download(cls, target_url: str, total_size: int, file_id: str) -> str:
        final_file_name = f"melo_{file_id}.mp4"
        final_output_path = os.path.join(settings.DOWNLOAD_DIR, final_file_name)

        async with aiohttp.ClientSession() as session:
            # Probe server to see if Range header is actually supported and check exact size
            supports_range = False
            actual_size = total_size

            try:
                headers = {"Range": "bytes=0-0", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
                async with session.get(target_url, headers=headers, timeout=aiohttp.ClientTimeout(total=10)) as probe_res:
                    if probe_res.status == 206:
                        supports_range = True
                        content_range = probe_res.headers.get("Content-Range", "")
                        if "/" in content_range:
                            total_from_header = content_range.split("/")[-1]
                            if total_from_header.isdigit():
                                actual_size = int(total_from_header)
                    elif probe_res.status == 200:
                        content_length = probe_res.headers.get("Content-Length")
                        if content_length and content_length.isdigit():
                            actual_size = int(content_length)
            except Exception:
                pass

            # If range is supported and we know the size, use segmented parallel chunks
            if supports_range and actual_size > 0:
                thread_count = 12 if actual_size > 50_000_000 else 8
                chunk_size = actual_size // thread_count
                
                task_temp_dir = os.path.join(settings.TEMP_DIR, f"task_{file_id}_{int(time.time())}")
                os.makedirs(task_temp_dir, exist_ok=True)
                
                tasks = []
                for i in range(thread_count):
                    start_byte = i * chunk_size
                    end_byte = actual_size - 1 if i == thread_count - 1 else (start_byte + chunk_size - 1)
                    tasks.append(cls._download_chunk(session, target_url, start_byte, end_byte, i, task_temp_dir))
                
                completed_chunk_paths = await asyncio.gather(*tasks)

                with open(final_output_path, "wb") as final_file:
                    for path in completed_chunk_paths:
                        with open(path, "rb") as chunk_file:
                            while chunk := chunk_file.read(64 * 1024):
                                final_file.write(chunk)
                        try:
                            os.remove(path)
                        except OSError:
                            pass
                        
                try:
                    os.rmdir(task_temp_dir)
                except OSError:
                    pass
            else:
                await cls._download_single_stream(session, target_url, final_output_path)

        return final_output_path