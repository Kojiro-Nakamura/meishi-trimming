document.addEventListener('DOMContentLoaded', () => {
    const initialView = document.getElementById('initial-view');
    const editorView = document.getElementById('editor-view');
    const imageInput = document.getElementById('image-input');
    const canvas = document.getElementById('editor-canvas');
    const ctx = canvas.getContext('2d');
    
    const saveBtn = document.getElementById('save-btn');
    const cancelBtn = document.getElementById('cancel-btn');
    const rotateLeftBtn = document.getElementById('rotate-left');
    const rotateRightBtn = document.getElementById('rotate-right');
    
    const resultView = document.getElementById('result-view');
    const croppedResultImg = document.getElementById('cropped-result');
    const downloadBtn = document.getElementById('download-btn');
    const backToEditBtn = document.getElementById('back-to-edit-btn');
    const startOverBtn = document.getElementById('start-over-btn');
    
    let originalFileName = 'business_card.jpg';
    let currentDataUrl = null;
    let sourceImage = new Image();

    // Editor state
    let points = []; // [{x, y}] in image coordinates
    let draggingPointIndex = -1;
    let displayScale = 1;
    let offsetX = 0;
    let offsetY = 0;

    // ファイル選択
    imageInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;

        originalFileName = file.name || 'business_card.jpg';
        // メモリ不足によるSafariのリロードを防ぐため、FileReaderではなくObjectURLを使用
        const objectUrl = URL.createObjectURL(file);
        loadImage(objectUrl);
    });

    function sortPoints(pts) {
        const sum = pts.map(p => p.x + p.y);
        const diff = pts.map(p => p.x - p.y);
        
        const tl = pts[sum.indexOf(Math.min(...sum))];
        const br = pts[sum.indexOf(Math.max(...sum))];
        const tr = pts[diff.indexOf(Math.max(...diff))];
        const bl = pts[diff.indexOf(Math.min(...diff))];
        
        return [tl, tr, br, bl];
    }

    function detectDocument(imgElement) {
        // OpenCVが完全に初期化されていない場合はスキップ
        if (typeof cv === 'undefined' || !cv.Mat || !cv.imread) {
            console.warn("OpenCV is not ready yet.");
            return null;
        }

        try {
            // メモリ制限(iOS Safari)を回避するため、OpenCVに渡す前にCanvasで縮小する
            let maxDim = 800;
            let scale = 1.0;
            if (imgElement.width > maxDim || imgElement.height > maxDim) {
                scale = maxDim / Math.max(imgElement.width, imgElement.height);
            }
            
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = imgElement.width * scale;
            tempCanvas.height = imgElement.height * scale;
            const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
            tempCtx.drawImage(imgElement, 0, 0, tempCanvas.width, tempCanvas.height);

            // 縮小済みのCanvasからOpenCVのMatを生成 (超軽量・高速)
            let src = cv.imread(tempCanvas);
            let resized = src; // すでにリサイズ済みなのでそのまま使用
            
            let gray = new cv.Mat();
            cv.cvtColor(resized, gray, cv.COLOR_RGBA2GRAY, 0);
            // ノイズ除去
            cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);

            // エッジ検出
            let edges = new cv.Mat();
            cv.Canny(gray, edges, 50, 150);

            // 輪郭を閉じて繋がりを良くする (Morphological Close)
            let M = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
            cv.morphologyEx(edges, edges, cv.MORPH_CLOSE, M);
            M.delete();

            // 輪郭検出
            let contours = new cv.MatVector();
            let hierarchy = new cv.Mat();
            cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

            let maxArea = 0;
            let maxContour = null;
            let approx = new cv.Mat();
            const totalArea = resized.cols * resized.rows;

            for (let i = 0; i < contours.size(); ++i) {
                let cnt = contours.get(i);
                let area = cv.contourArea(cnt);
                
                // 画面全体の5%以上、99%未満の領域のみ（大きく写した名刺も弾かないように上限を緩和）
                if (area > totalArea * 0.05 && area < totalArea * 0.99) {
                    
                    // 指の写り込みや名刺の欠けを無視するため、輪郭を凸包（Convex Hull）で包む
                    let hull = new cv.Mat();
                    cv.convexHull(cnt, hull, false, true);

                    let perimeter = cv.arcLength(hull, true);
                    let found4 = false;
                    
                    // 精度を変えながら4角形になるか試行する
                    for (let ep = 0.01; ep <= 0.15; ep += 0.01) {
                        cv.approxPolyDP(hull, approx, ep * perimeter, true);
                        if (approx.rows === 4) {
                            found4 = true;
                            break;
                        }
                    }
                    
                    if (found4) {
                        if (area > maxArea) {
                            maxArea = area;
                            if (maxContour) maxContour.delete();
                            maxContour = approx.clone();
                        }
                    }
                    hull.delete();
                }
                cnt.delete();
            }

            let foundPoints = null;
            if (maxContour) {
                foundPoints = [];
                for (let i = 0; i < 4; i++) {
                    foundPoints.push({
                        x: maxContour.data32S[i * 2] / scale,
                        y: maxContour.data32S[i * 2 + 1] / scale
                    });
                }
                maxContour.delete();
            }

            // メモリ解放
            src.delete(); gray.delete(); edges.delete();
            contours.delete(); hierarchy.delete(); approx.delete();

            if (foundPoints) {
                return sortPoints(foundPoints);
            }
            return null;
        } catch (err) {
            console.error("OpenCV detection failed", err);
            return null;
        }
    }

    function loadImage(src) {
        sourceImage.onload = () => {
            initialView.classList.remove('active');
            resultView.classList.remove('active');
            editorView.classList.add('active');

            // 4隅のポイントを初期化 (フォールバック用)
            const marginX = sourceImage.width * 0.1;
            const marginY = sourceImage.height * 0.1;
            points = [
                {x: marginX, y: marginY}, // Top-Left
                {x: sourceImage.width - marginX, y: marginY}, // Top-Right
                {x: sourceImage.width - marginX, y: sourceImage.height - marginY}, // Bottom-Right
                {x: marginX, y: sourceImage.height - marginY} // Bottom-Left
            ];

            // 自動認識に挑戦
            const detectedPoints = detectDocument(sourceImage);
            if (detectedPoints) {
                points = detectedPoints;
            }

            // DOMの表示が完了してからキャンバスサイズを計算するため少し遅延させる
            setTimeout(resizeCanvas, 50);
        };
        sourceImage.src = src;
    }

    // キャンバスのリサイズと描画の更新
    function resizeCanvas() {
        const container = document.getElementById('editor-container');
        // 解像度を上げるための対応 (Retina等)
        const dpr = window.devicePixelRatio || 1;
        
        // CSS上のサイズ
        const rect = container.getBoundingClientRect();
        canvas.style.width = rect.width + 'px';
        canvas.style.height = rect.height + 'px';
        
        // 実際のピクセルサイズ
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;

        // スケール計算 (contain)
        const scaleX = canvas.width / sourceImage.width;
        const scaleY = canvas.height / sourceImage.height;
        displayScale = Math.min(scaleX, scaleY);

        offsetX = (canvas.width - sourceImage.width * displayScale) / 2;
        offsetY = (canvas.height - sourceImage.height * displayScale) / 2;

        drawEditor();
    }

    window.addEventListener('resize', () => {
        if (editorView.classList.contains('active')) {
            resizeCanvas();
        }
    });

    function drawEditor() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        
        // 画像を描画
        ctx.drawImage(
            sourceImage,
            offsetX, offsetY,
            sourceImage.width * displayScale,
            sourceImage.height * displayScale
        );

        // ガイドラインを描画
        ctx.beginPath();
        for (let i = 0; i < points.length; i++) {
            const p = imgToCanvas(points[i]);
            if (i === 0) ctx.moveTo(p.x, p.y);
            else ctx.lineTo(p.x, p.y);
        }
        ctx.closePath();
        ctx.lineWidth = 2 * (window.devicePixelRatio || 1);
        ctx.strokeStyle = '#007aff'; // Primary color
        ctx.stroke();
        ctx.fillStyle = 'rgba(0, 122, 255, 0.2)';
        ctx.fill();

        // 頂点を描画
        const dpr = window.devicePixelRatio || 1;
        const radius = 20 * dpr; // 見た目をさらに大きくする (40px相当)
        for (let i = 0; i < points.length; i++) {
            const p = imgToCanvas(points[i]);
            ctx.beginPath();
            ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
            ctx.fillStyle = (i === draggingPointIndex) ? '#ff3b30' : '#ffffff';
            ctx.fill();
            ctx.lineWidth = 4 * dpr;
            ctx.strokeStyle = '#007aff';
            ctx.stroke();
        }
    }

    // 座標変換ヘルパー
    function imgToCanvas(p) {
        return {
            x: p.x * displayScale + offsetX,
            y: p.y * displayScale + offsetY
        };
    }

    function canvasToImg(x, y) {
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        // マウス/タッチ座標(CSSピクセル)からCanvas内ピクセル座標へ
        const cx = (x - rect.left) * dpr;
        const cy = (y - rect.top) * dpr;
        
        return {
            x: Math.max(0, Math.min(sourceImage.width, (cx - offsetX) / displayScale)),
            y: Math.max(0, Math.min(sourceImage.height, (cy - offsetY) / displayScale))
        };
    }

    // イベントハンドリング
    function getPointerPos(e) {
        if (e.touches && e.touches.length > 0) {
            return { x: e.touches[0].clientX, y: e.touches[0].clientY };
        }
        return { x: e.clientX, y: e.clientY };
    }

    function handleStart(e) {
        e.preventDefault();
        const pos = getPointerPos(e);
        const imgPos = canvasToImg(pos.x, pos.y);
        
        // 当たり判定をさらに特大に拡大（CSSピクセルで80px相当 -> 直径160px）
        const dpr = window.devicePixelRatio || 1;
        const threshold = (80 * dpr) / displayScale; 
        let minDist = Infinity;
        let closestIndex = -1;
        
        for (let i = 0; i < points.length; i++) {
            const dx = points[i].x - imgPos.x;
            const dy = points[i].y - imgPos.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < minDist && dist < threshold) {
                minDist = dist;
                closestIndex = i;
            }
        }
        
        if (closestIndex !== -1) {
            draggingPointIndex = closestIndex;
            // 触れた瞬間にポイントを指の位置に吸着させる (操作感が劇的に改善)
            points[draggingPointIndex] = imgPos;
            drawEditor();
        }
    }

    function handleMove(e) {
        if (draggingPointIndex === -1) return;
        e.preventDefault();
        const pos = getPointerPos(e);
        const imgPos = canvasToImg(pos.x, pos.y);
        points[draggingPointIndex] = imgPos;
        drawEditor();
    }

    function handleEnd(e) {
        if (draggingPointIndex !== -1) {
            draggingPointIndex = -1;
            drawEditor();
        }
    }

    canvas.addEventListener('mousedown', handleStart);
    canvas.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleEnd);

    canvas.addEventListener('touchstart', handleStart, {passive: false});
    canvas.addEventListener('touchmove', handleMove, {passive: false});
    window.addEventListener('touchend', handleEnd);

    // 回転
    function rotateImage(angleDegrees) {
        // 回転中の操作を防ぐ処理などを入れるとベターですが今回は同期的に近い速度で処理
        const offCanvas = document.createElement('canvas');
        const offCtx = offCanvas.getContext('2d');
        if (angleDegrees === 90 || angleDegrees === -270) {
            offCanvas.width = sourceImage.height;
            offCanvas.height = sourceImage.width;
            offCtx.translate(offCanvas.width, 0);
            offCtx.rotate(Math.PI / 2);
        } else if (angleDegrees === -90 || angleDegrees === 270) {
            offCanvas.width = sourceImage.height;
            offCanvas.height = sourceImage.width;
            offCtx.translate(0, offCanvas.height);
            offCtx.rotate(-Math.PI / 2);
        }
        offCtx.drawImage(sourceImage, 0, 0);
        
        // DataURLはメモリを大量に消費するためBlobを使用
        offCanvas.toBlob((blob) => {
            if (blob) {
                const objectUrl = URL.createObjectURL(blob);
                loadImage(objectUrl);
            }
        }, 'image/jpeg', 0.9);
    }

    rotateLeftBtn.addEventListener('click', () => rotateImage(-90));
    rotateRightBtn.addEventListener('click', () => rotateImage(90));

    // リセット関数
    const resetToInitial = () => {
        editorView.classList.remove('active');
        resultView.classList.remove('active');
        initialView.classList.add('active');
        
        imageInput.value = '';
        sourceImage.src = '';
        croppedResultImg.src = '';
        currentDataUrl = null;
    };

    cancelBtn.addEventListener('click', resetToInitial);
    startOverBtn.addEventListener('click', resetToInitial);

    backToEditBtn.addEventListener('click', () => {
        resultView.classList.remove('active');
        editorView.classList.add('active');
        // リサイズ再計算が必要な場合があるため
        setTimeout(resizeCanvas, 50);
    });

    // ==== 射影変換（Perspective Transform）の数学処理 ====
    function solveLinearSystem(A, B) {
        const n = A.length;
        for (let i = 0; i < n; i++) {
            let maxEl = Math.abs(A[i][i]), maxRow = i;
            for (let k = i + 1; k < n; k++) {
                if (Math.abs(A[k][i]) > maxEl) {
                    maxEl = Math.abs(A[k][i]);
                    maxRow = k;
                }
            }
            let tmp = A[maxRow]; A[maxRow] = A[i]; A[i] = tmp;
            let tmpB = B[maxRow]; B[maxRow] = B[i]; B[i] = tmpB;
            for (let k = i + 1; k < n; k++) {
                let c = -A[k][i] / A[i][i];
                for (let j = i; j < n; j++) {
                    if (i === j) A[k][j] = 0;
                    else A[k][j] += c * A[i][j];
                }
                B[k] += c * B[i];
            }
        }
        let x = new Array(n).fill(0);
        for (let i = n - 1; i >= 0; i--) {
            x[i] = B[i] / A[i][i];
            for (let k = i - 1; k >= 0; k--) {
                B[k] -= A[k][i] * x[i];
            }
        }
        return x;
    }

    function getPerspectiveTransform(srcPts, dstPts) {
        let A = [], B = [];
        for (let i = 0; i < 4; i++) {
            let u = dstPts[i].x, v = dstPts[i].y;
            let x = srcPts[i].x, y = srcPts[i].y;
            A.push([u, v, 1, 0, 0, 0, -x * u, -x * v]);
            B.push(x);
            A.push([0, 0, 0, u, v, 1, -y * u, -y * v]);
            B.push(y);
        }
        return solveLinearSystem(A, B);
    }

    function warpPerspective(srcCanvas, dstWidth, dstHeight, h) {
        const dstCanvas = document.createElement('canvas');
        dstCanvas.width = dstWidth;
        dstCanvas.height = dstHeight;
        const dstCtx = dstCanvas.getContext('2d');
        
        const srcCtx = srcCanvas.getContext('2d');
        const srcImgData = srcCtx.getImageData(0, 0, srcCanvas.width, srcCanvas.height);
        const dstImgData = dstCtx.createImageData(dstWidth, dstHeight);
        
        const srcData = srcImgData.data;
        const dstData = dstImgData.data;
        const sw = srcCanvas.width;
        const sh = srcCanvas.height;

        for (let y = 0; y < dstHeight; y++) {
            for (let x = 0; x < dstWidth; x++) {
                const denominator = h[6] * x + h[7] * y + 1;
                const srcX = (h[0] * x + h[1] * y + h[2]) / denominator;
                const srcY = (h[3] * x + h[4] * y + h[5]) / denominator;
                
                const srcX_f = Math.floor(srcX);
                const srcY_f = Math.floor(srcY);
                
                if (srcX_f >= 0 && srcX_f < sw - 1 && srcY_f >= 0 && srcY_f < sh - 1) {
                    const dx = srcX - srcX_f;
                    const dy = srcY - srcY_f;
                    
                    const idx1 = (srcY_f * sw + srcX_f) * 4;
                    const idx2 = idx1 + 4;
                    const idx3 = ((srcY_f + 1) * sw + srcX_f) * 4;
                    const idx4 = idx3 + 4;
                    
                    const dstIdx = (y * dstWidth + x) * 4;
                    
                    for (let c = 0; c < 3; c++) {
                        const val = srcData[idx1 + c] * (1 - dx) * (1 - dy) +
                                    srcData[idx2 + c] * dx * (1 - dy) +
                                    srcData[idx3 + c] * (1 - dx) * dy +
                                    srcData[idx4 + c] * dx * dy;
                        dstData[dstIdx + c] = val;
                    }
                    dstData[dstIdx + 3] = 255;
                }
            }
        }
        dstCtx.putImageData(dstImgData, 0, 0);
        return dstCanvas;
    }

    // 保存ボタン (Perspective Correction実行)
    saveBtn.addEventListener('click', () => {
        // 出力サイズは名刺の比率 (91:55) に合わせる。
        // ポイントの幅を基準に出力解像度を決定（最大長辺を1500px程度に制限）
        const widthT = Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);
        const widthB = Math.hypot(points[2].x - points[3].x, points[2].y - points[3].y);
        const estWidth = Math.max(widthT, widthB);
        
        let dstW = Math.min(Math.round(estWidth), 1500);
        let dstH = Math.round(dstW * (55 / 91));
        
        // 縦向きの短冊のような選択領域なら縦向き名刺(55:91)にする
        const heightL = Math.hypot(points[3].x - points[0].x, points[3].y - points[0].y);
        const heightR = Math.hypot(points[2].x - points[1].x, points[2].y - points[1].y);
        const estHeight = Math.max(heightL, heightR);
        if (estHeight > estWidth) {
            dstH = Math.min(Math.round(estHeight), 1500);
            dstW = Math.round(dstH * (55 / 91));
        }

        const dstPts = [
            {x: 0, y: 0},
            {x: dstW, y: 0},
            {x: dstW, y: dstH},
            {x: 0, y: dstH}
        ];

        // 変換行列を計算
        const H = getPerspectiveTransform(points, dstPts);

        // 高速化のため、ソース画像を一時キャンバスに描画してから処理
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = sourceImage.width;
        tempCanvas.height = sourceImage.height;
        tempCanvas.getContext('2d').drawImage(sourceImage, 0, 0);

        // 「処理中...」の表示等をしたいところだが、今回は同期的で約数十〜数百msで終わる
        setTimeout(() => {
            const warpedCanvas = warpPerspective(tempCanvas, dstW, dstH, H);
            currentDataUrl = warpedCanvas.toDataURL('image/jpeg', 0.9);
            
            croppedResultImg.src = currentDataUrl;
            editorView.classList.remove('active');
            resultView.classList.add('active');
        }, 10);
    });

    downloadBtn.addEventListener('click', () => {
        if (!currentDataUrl) return;
        const a = document.createElement('a');
        a.href = currentDataUrl;
        
        const nameParts = originalFileName.split('.');
        const ext = nameParts.length > 1 ? nameParts.pop() : 'jpg';
        const baseName = nameParts.join('.');
        a.download = `${baseName}_corrected.jpg`;
        
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    });
});
