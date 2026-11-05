(function(){
 'use strict';
 const $=id=>document.getElementById(id);
 const fileInput=$('documentImportFile');
 if(!fileInput)return;
 const seenDocumentNumbers=new Set();
 const setStatus=(text,error=false)=>{const el=$('documentImportStatus');el.textContent=text;el.className='status '+(error?'error':'success');};
 const escapeHtml=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 function toISO(raw){
   const m=String(raw||'').match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
   if(!m)return '';
   let year=Number(m[3]);if(year<100)year+=2500; if(year>=2400)year-=543;
   const day=Number(m[1]),month=Number(m[2]);
   if(month<1||month>12||day<1||day>31)return '';
   return String(year).padStart(4,'0')+'-'+String(month).padStart(2,'0')+'-'+String(day).padStart(2,'0');
 }
 const normalize=s=>String(s??'').replace(/\s+/g,' ').trim();
 const productBySku=sku=>(window.productsData||[]).find(p=>String(p.sku??'').trim()===String(sku).trim());
 function groupRows(items){
   const sorted=items.filter(x=>normalize(x.str)).map(x=>({text:normalize(x.str),x:x.x,y:x.y})).sort((a,b)=>a.y-b.y||a.x-b.x);
   const rows=[];
   for(const item of sorted){
     let row=rows.find(r=>Math.abs(r.y-item.y)<=2.8);
     if(!row){row={y:item.y,items:[]};rows.push(row);}
     row.items.push(item);
     row.y=row.items.reduce((s,v)=>s+v.y,0)/row.items.length;
   }
   return rows.map(r=>({y:r.y,items:r.items.sort((a,b)=>a.x-b.x),text:r.items.map(x=>x.text).join(' ')})).sort((a,b)=>a.y-b.y);
 }
 function findCell(row,minX,maxX,pattern){
   return row.items.filter(x=>x.x>=minX&&x.x<maxX).map(x=>x.text).find(s=>pattern.test(s))||'';
 }
 function parsePositioned(pages){
   const allItems=pages.flat();
   const rows=groupRows(allItems);
   const allText=rows.map(r=>r.text).join('\n');
   const docNoItem=allItems.find(x=>x.x>=400&&/\b(?:Q|BK)\d{6}\/\d{4,6}\b/i.test(x.str));
   const number=(docNoItem?.str.match(/\b(?:Q|BK)\d{6}\/\d{4,6}\b/i)||[])[0]||'';
   const quote=/ใบเสนอราคา|quotation|\bQ\d{6}\//i.test(allText);
   const reservation=/ใบจอง|\bBK\d{6}\//i.test(allText);
   const dateRows=rows.filter(r=>r.y>=125&&r.y<=215);
   const dateCells=dateRows.map(r=>({y:r.y,value:findCell(r,400,590,/^\d{1,2}\/\d{1,2}\/\d{2,4}$/)})).filter(x=>x.value);
   const date=dateCells[0]?.value||'';
   const dueDate=dateCells[1]?.value||'';
   const expiryDate=dateCells[2]?.value||'';
   const deliveryRow=rows.find(r=>r.y>=205&&r.y<=225&&r.items.some(x=>x.x>=400&&/รับเอง|Flash|Kerry|J&T|ไปรษณีย์|ขนส่ง/i.test(x.text)));
   const delivery=deliveryRow?.items.filter(x=>x.x>=400).map(x=>x.text).join(' ')||'';
   const headerTable=rows.find(r=>r.y>=255&&r.y<=280&&/รห.*สนค|รหัสสินค้า|SKU/i.test(r.text));
   const tableTop=headerTable?.y??270;
   const totalY=rows.find(r=>r.y>tableTop&&/รวมท.*หมด|รวมทั้งหมด/.test(r.text))?.y??560;
   const itemRows=rows.filter(r=>r.y>tableTop+3&&r.y<totalY);
   const items=[];
   for(const row of itemRows){
     const sku=findCell(row,18,115,/^(?:\d{3,5}|\d{1,4}\/\d{1,4})$/);
     if(!sku)continue;
     const name=row.items.filter(x=>x.x>=120&&x.x<290).map(x=>x.text).join(' ').trim();
     const qtyText=findCell(row,335,410,/^\d+(?:\.\d+)?$/);
     const quantity=qtyText?Math.max(1,Math.round(Number(qtyText))):0;
     const service=sku==='4/2'||/ค่าบริการ|บริการจัดส่ง|จตดสทง|shipping|delivery service/i.test(name);
     const product=service?null:productBySku(sku);
     items.push({sku,name:product?.product_name||name||'ไม่พบชื่อในฐานข้อมูลสินค้า',quantity,is_inventory:!service,unit:service?'ครั้ง':'ชุด',matched_product:!!product});
   }
   const warnings=[];
   if(!number)warnings.push('ไม่พบเลขที่เอกสารในตำแหน่งหัวเอกสาร กรุณาตรวจสอบและกรอกเอง');
   if(!date)warnings.push('ไม่พบวันที่เอกสารในตำแหน่งที่คาดไว้ กรุณาตรวจสอบ');
   if(!items.length)warnings.push('ไม่พบแถวสินค้าในบริเวณตาราง กรุณาตรวจสอบรูปแบบ PDF');
   if(items.some(x=>!x.matched_product&&!['4/2'].includes(x.sku)))warnings.push('มี SKU ที่ไม่พบในฐานข้อมูลสินค้า กรุณาตรวจสอบก่อนใช้งาน');
   if(items.some(x=>x.sku==='4/2'))warnings.push('พบ SKU 4/2 ซึ่งเป็นค่าบริการ ไม่ควรนับเป็นสินค้าในคลัง');
   if(reservation&&/รับเอง/.test(allText)&&/Flash Express|ขนส่ง/i.test(allText))warnings.push('ข้อมูลวิธีจัดส่งขัดแย้งกัน: ช่องวิธีจัดส่งระบุ “รับเอง” แต่หมายเหตุระบุ Flash Express กรุณาตรวจสอบ');
   if(number&&seenDocumentNumbers.has(number))warnings.push('พบเลขที่เอกสารนี้ซ้ำกับไฟล์ที่อ่านไปแล้วในรอบการใช้งานนี้');
   return {type:quote?'QUOTATION':reservation?'RESERVATION':'UNKNOWN',number,date:toISO(date),dueDate:toISO(dueDate),expiryDate:toISO(expiryDate),delivery,items,warnings,rawText:allText};
 }
 function render(result){
   $('diType').value=result.type;$('diNumber').value=result.number;$('diDate').value=result.date;$('diDueDate').value=result.dueDate;$('diExpiryDate').value=result.expiryDate;$('diDelivery').value=result.delivery;
   $('documentImportWarnings').innerHTML=result.warnings.length?'<strong>โปรดตรวจสอบ</strong><ul>'+result.warnings.map(x=>'<li>'+escapeHtml(x)+'</li>').join('')+'</ul>':'<strong>ไม่พบคำเตือนจากการอ่านเบื้องต้น</strong>';
   $('documentImportWarnings').classList.remove('hidden');
   $('documentImportLines').innerHTML=result.items.length?result.items.map((x,i)=>'<article class="picking-line-card" data-di-row="'+i+'"><div class="form-grid"><div><label>SKU</label><input data-di-field="sku" value="'+escapeHtml(x.sku)+'"></div><div><label>ชื่อรายการ</label><input data-di-field="name" value="'+escapeHtml(x.name)+'"></div><div><label>จำนวน</label><input data-di-field="quantity" type="number" min="0" step="1" value="'+x.quantity+'"></div></div><label style="display:flex;align-items:center;gap:8px;margin-top:8px"><input data-di-field="inventory" type="checkbox" '+(x.is_inventory?'checked':'')+' style="width:auto"> นับเป็นสินค้าในคลัง (ยกเลิกสำหรับค่าบริการ)</label></article>').join(''):'<p class="error">ยังไม่พบรายการสินค้า กรุณาตรวจสอบ PDF</p>';
   $('documentImportReview').classList.remove('hidden');
 }
 async function readPdf(file){
   if(!window.pdfjsLib)throw new Error('โหลดตัวอ่าน PDF ไม่สำเร็จ กรุณารีเฟรชหน้าเว็บแล้วลองใหม่');
   window.pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
   const data=new Uint8Array(await file.arrayBuffer()),pdf=await window.pdfjsLib.getDocument({data}).promise,pages=[];
   for(let p=1;p<=pdf.numPages;p++){
     const page=await pdf.getPage(p),viewport=page.getViewport({scale:1}),content=await page.getTextContent(),items=[];
     for(const x of content.items){
       if(!x.str||!x.str.trim())continue;
       const point=viewport.convertToViewportPoint(x.transform[4],x.transform[5]);
       items.push({str:x.str,x:point[0],y:point[1]});
     }
     pages.push(items);
   }
   return pages;
 }
 fileInput.addEventListener('change',async()=>{
   const file=fileInput.files?.[0];if(!file)return;
   $('documentImportReview').classList.add('hidden');$('documentImportWarnings').classList.add('hidden');
   setStatus('กำลังอ่าน PDF และแยกข้อมูลตามตำแหน่งบนเอกสาร: '+file.name+' ...');
   try{
     const pages=await readPdf(file);
     if(!pages.some(p=>p.length)){setStatus('ไฟล์นี้ไม่มีข้อความให้อ่าน อาจเป็น PDF แบบภาพสแกน รุ่นนี้ยังไม่รองรับ OCR',true);return;}
     const parsed=parsePositioned(pages);if(parsed.number)seenDocumentNumbers.add(parsed.number);render(parsed);
     setStatus('อ่าน PDF เสร็จแล้ว · พบ '+parsed.items.length+' แถวในบริเวณตาราง · กรุณาตรวจสอบทุกช่องก่อนใช้งาน · ไม่มีการบันทึกข้อมูล');
   }catch(e){setStatus('อ่านไฟล์ไม่สำเร็จ: '+(e?.message||e),true);}
 });
 $('documentImportLines').addEventListener('input',e=>{
   const row=e.target.closest('[data-di-row]');if(!row)return;
   if(e.target.dataset.diField==='quantity'&&Number(e.target.value)<0)e.target.value='0';
 });
 $('documentImportResetBtn').addEventListener('click',()=>{
   fileInput.value='';$('documentImportReview').classList.add('hidden');$('documentImportWarnings').classList.add('hidden');setStatus('ล้างผลการอ่านแล้ว กรุณาเลือกไฟล์ PDF ใหม่');
 });
 const tile=document.querySelector('[data-warehouse-action="DOC_IMPORT"]');
 tile?.addEventListener('click',e=>{
   e.stopImmediatePropagation();
   const panel=$('documentImportPanel');
   document.querySelectorAll('.workflow-panel').forEach(p=>{p.classList.add('hidden');p.classList.remove('workflow-popup-active');});
   panel.classList.remove('hidden');panel.classList.add('workflow-popup-active');panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');
   document.body.classList.add('workflow-modal-active');
   if(!panel.querySelector('.workflow-popup-close-row')){
     const row=document.createElement('div');row.className='workflow-popup-close-row';
     const close=document.createElement('button');close.type='button';close.className='workflow-popup-close';close.textContent='ปิด กลับเมนู';
     close.addEventListener('click',()=>{panel.classList.add('hidden');panel.classList.remove('workflow-popup-active');panel.removeAttribute('role');panel.removeAttribute('aria-modal');document.body.classList.remove('workflow-modal-active');});
     row.appendChild(close);panel.insertBefore(row,panel.firstChild);
   }
   $('documentImportReview').classList.add('hidden');setStatus('เลือกไฟล์ PDF เพื่อเริ่มอ่านเอกสาร');
 },true);
})();