//! Writes a step guide out as Markdown, HTML, a Word document or a
//! PowerPoint deck, from the flattened step images the Guide window sends.
//!
//! Markdown is `<name>.md` with a `<name> images/` folder of `step-01.png`
//! onwards; HTML is one file with the images inline as base64. The .docx
//! and .pptx files are hand-written Office Open XML packed with `zip`: a
//! numbered heading per step in Word, a slide per step in PowerPoint, each
//! with the step's description and image.

use std::{
    fs,
    io::{Cursor, Write},
    path::Path,
};

use base64::{Engine, prelude::BASE64_STANDARD};
use zip::{ZipWriter, write::SimpleFileOptions};

/// One step to export: its description and flattened PNG.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Step {
    pub description: String,
    pub png: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

impl Step {
    pub fn new(description: String, png: Vec<u8>) -> Result<Self, String> {
        let (width, height) = image::ImageReader::new(Cursor::new(&png))
            .with_guessed_format()
            .map_err(|err| err.to_string())?
            .into_dimensions()
            .map_err(|err| format!("a step's image is not valid: {err}"))?;
        Ok(Self {
            description,
            png,
            width,
            height,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Markdown,
    Html,
    Docx,
    Pptx,
}

impl Format {
    pub fn parse(name: &str) -> Result<Self, String> {
        match name {
            "markdown" | "md" => Ok(Self::Markdown),
            "html" => Ok(Self::Html),
            "docx" => Ok(Self::Docx),
            "pptx" => Ok(Self::Pptx),
            other => Err(format!("cannot export a guide as `{other}`")),
        }
    }
}

/// Writes `steps` as `format` to `path`.
pub fn write(format: Format, path: &Path, title: &str, steps: &[Step]) -> Result<(), String> {
    let fail = |err: std::io::Error| format!("could not export the guide: {err}");
    match format {
        Format::Markdown => {
            let stem = path
                .file_stem()
                .map(|stem| stem.to_string_lossy().into_owned())
                .unwrap_or_else(|| "guide".into());
            let images = format!("{stem} images");
            let dir = path.parent().unwrap_or(Path::new(".")).join(&images);
            fs::create_dir_all(&dir).map_err(fail)?;
            for (index, step) in steps.iter().enumerate() {
                fs::write(dir.join(image_name(index)), &step.png).map_err(fail)?;
            }
            fs::write(path, markdown(title, steps, &images)).map_err(fail)
        }
        Format::Html => fs::write(path, html(title, steps)).map_err(fail),
        Format::Docx => fs::write(path, docx(title, steps)?).map_err(fail),
        Format::Pptx => fs::write(path, pptx(title, steps)?).map_err(fail),
    }
}

/// `step-01.png` for the first step.
pub fn image_name(index: usize) -> String {
    format!("step-{:02}.png", index + 1)
}

/// The step's description, or `Step <n>` when it has none.
fn label(index: usize, step: &Step) -> String {
    let text = step.description.trim();
    if text.is_empty() {
        format!("Step {}", index + 1)
    } else {
        text.to_owned()
    }
}

/// Markdown that shows each step's image from the `images` folder beside it.
pub fn markdown(title: &str, steps: &[Step], images: &str) -> String {
    let mut out = format!("# {title}\n");
    for (index, step) in steps.iter().enumerate() {
        out.push_str(&format!(
            "\n## {}. {}\n\n![Step {}](<{}/{}>)\n",
            index + 1,
            label(index, step),
            index + 1,
            images,
            image_name(index)
        ));
    }
    out
}

/// The guide as Markdown text without images, for the clipboard.
pub fn markdown_text(title: &str, steps: &[Step]) -> String {
    let mut out = format!("# {title}\n\n");
    for (index, step) in steps.iter().enumerate() {
        out.push_str(&format!("{}. {}\n", index + 1, label(index, step)));
    }
    out
}

/// Escapes text for HTML and XML.
pub fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(ch),
        }
    }
    out
}

/// One HTML file with every image inline.
pub fn html(title: &str, steps: &[Step]) -> String {
    let title = escape(title);
    let mut out = format!(
        "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<title>{title}</title>\n\
<style>body{{font-family:system-ui,sans-serif;max-width:960px;margin:2rem auto;padding:0 1rem;color:#1f2328}}\
img{{max-width:100%;border:1px solid #d0d7de;border-radius:6px}}h2{{margin-top:2rem}}</style>\n</head>\n<body>\n<h1>{title}</h1>\n"
    );
    for (index, step) in steps.iter().enumerate() {
        out.push_str(&format!(
            "<section>\n<h2>{}. {}</h2>\n<img src=\"data:image/png;base64,{}\" alt=\"Step {}\" width=\"{}\">\n</section>\n",
            index + 1,
            escape(&label(index, step)),
            BASE64_STANDARD.encode(&step.png),
            index + 1,
            step.width
        ));
    }
    out.push_str("</body>\n</html>\n");
    out
}

/// English Metric Units per pixel at 96 dpi.
const EMU_PER_PIXEL: u64 = 9525;

/// `width` by `height` pixels in EMU, shrunk to fit `max` keeping its shape.
pub fn fit_emu(width: u32, height: u32, max: (u64, u64)) -> (u64, u64) {
    let w = u64::from(width.max(1)) * EMU_PER_PIXEL;
    let h = u64::from(height.max(1)) * EMU_PER_PIXEL;
    let scale = (max.0 as f64 / w as f64)
        .min(max.1 as f64 / h as f64)
        .min(1.0);
    (
        ((w as f64 * scale).round() as u64).max(1),
        ((h as f64 * scale).round() as u64).max(1),
    )
}

struct Package {
    zip: ZipWriter<Cursor<Vec<u8>>>,
}

impl Package {
    fn new() -> Self {
        Self {
            zip: ZipWriter::new(Cursor::new(Vec::new())),
        }
    }

    fn add(&mut self, name: &str, bytes: &[u8]) -> Result<(), String> {
        self.zip
            .start_file(name, SimpleFileOptions::default())
            .map_err(|err| err.to_string())?;
        self.zip.write_all(bytes).map_err(|err| err.to_string())
    }

    fn finish(self) -> Result<Vec<u8>, String> {
        self.zip
            .finish()
            .map(Cursor::into_inner)
            .map_err(|err| err.to_string())
    }
}

const XML_HEAD: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n";
const REL_IMAGE: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";
const REL_DOCUMENT: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";

fn root_rels(target: &str) -> String {
    format!(
        "{XML_HEAD}<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
<Relationship Id=\"rId1\" Type=\"{REL_DOCUMENT}\" Target=\"{target}\"/></Relationships>"
    )
}

/// A picture element for DrawingML, shared by Word and PowerPoint.
fn pic(id: usize, name: &str, rel: &str, cx: u64, cy: u64, x: u64, y: u64) -> String {
    format!(
        "<pic:pic xmlns:pic=\"http://schemas.openxmlformats.org/drawingml/2006/picture\">\
<pic:nvPicPr><pic:cNvPr id=\"{id}\" name=\"{name}\"/><pic:cNvPicPr/></pic:nvPicPr>\
<pic:blipFill><a:blip r:embed=\"{rel}\"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>\
<pic:spPr><a:xfrm><a:off x=\"{x}\" y=\"{y}\"/><a:ext cx=\"{cx}\" cy=\"{cy}\"/></a:xfrm>\
<a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>"
    )
}

/// A Word document: the title, then a numbered heading per step with its
/// image below.
pub fn docx(title: &str, steps: &[Step]) -> Result<Vec<u8>, String> {
    // Six inches wide and eight high at most: inside the default margins.
    const MAX: (u64, u64) = (5_486_400, 7_315_200);
    let mut body = format!(
        "<w:p><w:pPr><w:pStyle w:val=\"Title\"/></w:pPr><w:r><w:t xml:space=\"preserve\">{}</w:t></w:r></w:p>",
        escape(title)
    );
    let mut rels = String::new();
    for (index, step) in steps.iter().enumerate() {
        let n = index + 1;
        let rel = format!("rIdImg{n}");
        let (cx, cy) = fit_emu(step.width, step.height, MAX);
        body.push_str(&format!(
            "<w:p><w:pPr><w:pStyle w:val=\"Heading1\"/></w:pPr><w:r><w:t xml:space=\"preserve\">{n}. {}</w:t></w:r></w:p>",
            escape(&label(index, step))
        ));
        body.push_str(&format!(
            "<w:p><w:r><w:drawing><wp:inline distT=\"0\" distB=\"0\" distL=\"0\" distR=\"0\">\
<wp:extent cx=\"{cx}\" cy=\"{cy}\"/><wp:docPr id=\"{n}\" name=\"Step {n}\"/>\
<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect=\"1\"/></wp:cNvGraphicFramePr>\
<a:graphic><a:graphicData uri=\"http://schemas.openxmlformats.org/drawingml/2006/picture\">{}</a:graphicData></a:graphic>\
</wp:inline></w:drawing></w:r></w:p>",
            pic(n, &image_name(index), &rel, cx, cy, 0, 0)
        ));
        rels.push_str(&format!(
            "<Relationship Id=\"{rel}\" Type=\"{REL_IMAGE}\" Target=\"media/{}\"/>",
            image_name(index)
        ));
    }
    let document = format!(
        "{XML_HEAD}<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\" \
xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" \
xmlns:wp=\"http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing\" \
xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\">\
<w:body>{body}<w:sectPr><w:pgSz w:w=\"12240\" w:h=\"15840\"/>\
<w:pgMar w:top=\"1440\" w:right=\"1440\" w:bottom=\"1440\" w:left=\"1440\" w:header=\"720\" w:footer=\"720\" w:gutter=\"0\"/></w:sectPr></w:body></w:document>"
    );
    let document_rels = format!(
        "{XML_HEAD}<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
<Relationship Id=\"rIdStyles\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/>{rels}</Relationships>"
    );
    let styles = format!(
        "{XML_HEAD}<w:styles xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">\
<w:style w:type=\"paragraph\" w:default=\"1\" w:styleId=\"Normal\"><w:name w:val=\"Normal\"/><w:pPr><w:spacing w:after=\"160\"/></w:pPr><w:rPr><w:sz w:val=\"22\"/></w:rPr></w:style>\
<w:style w:type=\"paragraph\" w:styleId=\"Title\"><w:name w:val=\"Title\"/><w:basedOn w:val=\"Normal\"/><w:next w:val=\"Normal\"/><w:qFormat/><w:rPr><w:sz w:val=\"52\"/></w:rPr></w:style>\
<w:style w:type=\"paragraph\" w:styleId=\"Heading1\"><w:name w:val=\"heading 1\"/><w:basedOn w:val=\"Normal\"/><w:next w:val=\"Normal\"/><w:qFormat/>\
<w:pPr><w:keepNext/><w:spacing w:before=\"360\" w:after=\"120\"/><w:outlineLvl w:val=\"0\"/></w:pPr><w:rPr><w:b/><w:sz w:val=\"30\"/></w:rPr></w:style></w:styles>"
    );
    let content_types = format!(
        "{XML_HEAD}<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">\
<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>\
<Default Extension=\"xml\" ContentType=\"application/xml\"/><Default Extension=\"png\" ContentType=\"image/png\"/>\
<Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/>\
<Override PartName=\"/word/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml\"/></Types>"
    );
    let mut package = Package::new();
    package.add("[Content_Types].xml", content_types.as_bytes())?;
    package.add("_rels/.rels", root_rels("word/document.xml").as_bytes())?;
    package.add("word/document.xml", document.as_bytes())?;
    package.add("word/_rels/document.xml.rels", document_rels.as_bytes())?;
    package.add("word/styles.xml", styles.as_bytes())?;
    for (index, step) in steps.iter().enumerate() {
        package.add(&format!("word/media/{}", image_name(index)), &step.png)?;
    }
    package.finish()
}

const SLIDE_WIDTH: u64 = 12_192_000;
const SLIDE_HEIGHT: u64 = 6_858_000;
const NS_PML: &str = "xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" \
xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" \
xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\"";
const EMPTY_TREE: &str = "<p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>\
<p:grpSpPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"0\" cy=\"0\"/><a:chOff x=\"0\" y=\"0\"/><a:chExt cx=\"0\" cy=\"0\"/></a:xfrm></p:grpSpPr>";

fn text_box(id: usize, text: &str, y: u64, height: u64, size: u32, bold: bool) -> String {
    format!(
        "<p:sp><p:nvSpPr><p:cNvPr id=\"{id}\" name=\"Text {id}\"/><p:cNvSpPr txBox=\"1\"/><p:nvPr/></p:nvSpPr>\
<p:spPr><a:xfrm><a:off x=\"457200\" y=\"{y}\"/><a:ext cx=\"11277600\" cy=\"{height}\"/></a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></p:spPr>\
<p:txBody><a:bodyPr wrap=\"square\" anchor=\"ctr\"><a:normAutofit/></a:bodyPr><a:lstStyle/><a:p><a:r><a:rPr lang=\"en-US\" sz=\"{size}\" b=\"{}\"/><a:t>{}</a:t></a:r></a:p></p:txBody></p:sp>",
        u8::from(bold),
        escape(text)
    )
}

fn slide_rels(extra: &str) -> String {
    format!(
        "{XML_HEAD}<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout\" Target=\"../slideLayouts/slideLayout1.xml\"/>{extra}</Relationships>"
    )
}

/// A PowerPoint deck: a title slide, then a slide per step with its
/// numbered description above its image.
pub fn pptx(title: &str, steps: &[Step]) -> Result<Vec<u8>, String> {
    let mut slides: Vec<(String, String)> = vec![(
        format!(
            "{XML_HEAD}<p:sld {NS_PML}><p:cSld><p:spTree>{EMPTY_TREE}{}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>",
            text_box(2, title, 2_743_200, 1_371_600, 4000, true)
        ),
        slide_rels(""),
    )];
    // Below the heading, inside a half-inch margin.
    const IMAGE_TOP: u64 = 1_280_160;
    const MAX: (u64, u64) = (SLIDE_WIDTH - 914_400, SLIDE_HEIGHT - IMAGE_TOP - 457_200);
    for (index, step) in steps.iter().enumerate() {
        let (cx, cy) = fit_emu(step.width, step.height, MAX);
        let x = (SLIDE_WIDTH - cx) / 2;
        let heading = format!("{}. {}", index + 1, label(index, step));
        let xml = format!(
            "{XML_HEAD}<p:sld {NS_PML} xmlns:pic=\"http://schemas.openxmlformats.org/drawingml/2006/picture\"><p:cSld><p:spTree>{EMPTY_TREE}{}{}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>",
            text_box(2, &heading, 228_600, 914_400, 2400, true),
            pic(3, &image_name(index), "rId2", cx, cy, x, IMAGE_TOP)
                .replace("pic:pic", "p:pic")
                .replace("pic:nvPicPr", "p:nvPicPr")
                .replace("pic:cNvPr", "p:cNvPr")
                .replace("pic:cNvPicPr", "p:cNvPicPr")
                .replace("<p:cNvPicPr/>", "<p:cNvPicPr/><p:nvPr/>")
                .replace("pic:blipFill", "p:blipFill")
                .replace("pic:spPr", "p:spPr")
                .replace(
                    " xmlns:pic=\"http://schemas.openxmlformats.org/drawingml/2006/picture\"",
                    ""
                )
        );
        let rels = slide_rels(&format!(
            "<Relationship Id=\"rId2\" Type=\"{REL_IMAGE}\" Target=\"../media/{}\"/>",
            image_name(index)
        ));
        slides.push((xml, rels));
    }

    let mut slide_ids = String::new();
    let mut presentation_rels = String::from(
        "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster\" Target=\"slideMasters/slideMaster1.xml\"/>\
<Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme\" Target=\"theme/theme1.xml\"/>",
    );
    let mut overrides = String::new();
    for n in 1..=slides.len() {
        slide_ids.push_str(&format!(
            "<p:sldId id=\"{}\" r:id=\"rIdSlide{n}\"/>",
            255 + n
        ));
        presentation_rels.push_str(&format!(
            "<Relationship Id=\"rIdSlide{n}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide\" Target=\"slides/slide{n}.xml\"/>"
        ));
        overrides.push_str(&format!(
            "<Override PartName=\"/ppt/slides/slide{n}.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slide+xml\"/>"
        ));
    }
    let presentation = format!(
        "{XML_HEAD}<p:presentation {NS_PML}><p:sldMasterIdLst><p:sldMasterId id=\"2147483648\" r:id=\"rId1\"/></p:sldMasterIdLst>\
<p:sldIdLst>{slide_ids}</p:sldIdLst><p:sldSz cx=\"{SLIDE_WIDTH}\" cy=\"{SLIDE_HEIGHT}\"/><p:notesSz cx=\"6858000\" cy=\"9144000\"/></p:presentation>"
    );
    let rels_head =
        "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">";
    let master = format!(
        "{XML_HEAD}<p:sldMaster {NS_PML}><p:cSld><p:bg><p:bgRef idx=\"1001\"><a:schemeClr val=\"bg1\"/></p:bgRef></p:bg><p:spTree>{EMPTY_TREE}</p:spTree></p:cSld>\
<p:clrMap bg1=\"lt1\" tx1=\"dk1\" bg2=\"lt2\" tx2=\"dk2\" accent1=\"accent1\" accent2=\"accent2\" accent3=\"accent3\" accent4=\"accent4\" accent5=\"accent5\" accent6=\"accent6\" hlink=\"hlink\" folHlink=\"folHlink\"/>\
<p:sldLayoutIdLst><p:sldLayoutId id=\"2147483649\" r:id=\"rId1\"/></p:sldLayoutIdLst></p:sldMaster>"
    );
    let master_rels = format!(
        "{XML_HEAD}{rels_head}<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout\" Target=\"../slideLayouts/slideLayout1.xml\"/>\
<Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme\" Target=\"../theme/theme1.xml\"/></Relationships>"
    );
    let layout = format!(
        "{XML_HEAD}<p:sldLayout {NS_PML} type=\"blank\" preserve=\"1\"><p:cSld name=\"Blank\"><p:spTree>{EMPTY_TREE}</p:spTree></p:cSld>\
<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>"
    );
    let layout_rels = format!(
        "{XML_HEAD}{rels_head}<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster\" Target=\"../slideMasters/slideMaster1.xml\"/></Relationships>"
    );
    let content_types = format!(
        "{XML_HEAD}<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">\
<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>\
<Default Extension=\"xml\" ContentType=\"application/xml\"/><Default Extension=\"png\" ContentType=\"image/png\"/>\
<Override PartName=\"/ppt/presentation.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml\"/>\
<Override PartName=\"/ppt/slideMasters/slideMaster1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml\"/>\
<Override PartName=\"/ppt/slideLayouts/slideLayout1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml\"/>\
<Override PartName=\"/ppt/theme/theme1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.theme+xml\"/>{overrides}</Types>"
    );

    let mut package = Package::new();
    package.add("[Content_Types].xml", content_types.as_bytes())?;
    package.add("_rels/.rels", root_rels("ppt/presentation.xml").as_bytes())?;
    package.add("ppt/presentation.xml", presentation.as_bytes())?;
    package.add(
        "ppt/_rels/presentation.xml.rels",
        format!("{XML_HEAD}{rels_head}{presentation_rels}</Relationships>").as_bytes(),
    )?;
    package.add("ppt/slideMasters/slideMaster1.xml", master.as_bytes())?;
    package.add(
        "ppt/slideMasters/_rels/slideMaster1.xml.rels",
        master_rels.as_bytes(),
    )?;
    package.add("ppt/slideLayouts/slideLayout1.xml", layout.as_bytes())?;
    package.add(
        "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
        layout_rels.as_bytes(),
    )?;
    package.add("ppt/theme/theme1.xml", THEME.as_bytes())?;
    for (index, (xml, rels)) in slides.iter().enumerate() {
        let n = index + 1;
        package.add(&format!("ppt/slides/slide{n}.xml"), xml.as_bytes())?;
        package.add(
            &format!("ppt/slides/_rels/slide{n}.xml.rels"),
            rels.as_bytes(),
        )?;
    }
    for (index, step) in steps.iter().enumerate() {
        package.add(&format!("ppt/media/{}", image_name(index)), &step.png)?;
    }
    package.finish()
}

/// The smallest complete theme PowerPoint accepts.
const THEME: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n\
<a:theme xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" name=\"Grab-it\"><a:themeElements>\
<a:clrScheme name=\"Grab-it\"><a:dk1><a:srgbClr val=\"1F2328\"/></a:dk1><a:lt1><a:srgbClr val=\"FFFFFF\"/></a:lt1>\
<a:dk2><a:srgbClr val=\"44546A\"/></a:dk2><a:lt2><a:srgbClr val=\"E7E6E6\"/></a:lt2>\
<a:accent1><a:srgbClr val=\"E5484D\"/></a:accent1><a:accent2><a:srgbClr val=\"F5A524\"/></a:accent2>\
<a:accent3><a:srgbClr val=\"30A46C\"/></a:accent3><a:accent4><a:srgbClr val=\"0090FF\"/></a:accent4>\
<a:accent5><a:srgbClr val=\"8E4EC6\"/></a:accent5><a:accent6><a:srgbClr val=\"70AD47\"/></a:accent6>\
<a:hlink><a:srgbClr val=\"0563C1\"/></a:hlink><a:folHlink><a:srgbClr val=\"954F72\"/></a:folHlink></a:clrScheme>\
<a:fontScheme name=\"Grab-it\"><a:majorFont><a:latin typeface=\"Calibri\"/><a:ea typeface=\"\"/><a:cs typeface=\"\"/></a:majorFont>\
<a:minorFont><a:latin typeface=\"Calibri\"/><a:ea typeface=\"\"/><a:cs typeface=\"\"/></a:minorFont></a:fontScheme>\
<a:fmtScheme name=\"Grab-it\"><a:fillStyleLst><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill>\
<a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill></a:fillStyleLst>\
<a:lnStyleLst><a:ln w=\"6350\"><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill></a:ln>\
<a:ln w=\"12700\"><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill></a:ln>\
<a:ln w=\"19050\"><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill></a:ln></a:lnStyleLst>\
<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle>\
<a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>\
<a:bgFillStyleLst><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill>\
<a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>";

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn png(width: u32, height: u32) -> Vec<u8> {
        let image = image::RgbaImage::from_pixel(width, height, image::Rgba([1, 2, 3, 255]));
        let mut bytes = Vec::new();
        image
            .write_to(&mut Cursor::new(&mut bytes), image::ImageFormat::Png)
            .unwrap();
        bytes
    }

    fn steps() -> Vec<Step> {
        vec![
            Step::new("Open the <File> menu".into(), png(40, 30)).unwrap(),
            Step::new(" ".into(), png(20, 10)).unwrap(),
            Step::new("Click Save & close".into(), png(10, 10)).unwrap(),
        ]
    }

    fn entry(archive: &[u8], name: &str) -> String {
        let mut zip = zip::ZipArchive::new(Cursor::new(archive)).unwrap();
        let mut text = String::new();
        zip.by_name(name)
            .unwrap()
            .read_to_string(&mut text)
            .unwrap();
        text
    }

    fn names(archive: &[u8]) -> Vec<String> {
        let zip = zip::ZipArchive::new(Cursor::new(archive)).unwrap();
        zip.file_names().map(str::to_owned).collect()
    }

    #[test]
    fn steps_know_their_image_size() {
        let step = Step::new("x".into(), png(40, 30)).unwrap();
        assert_eq!((step.width, step.height), (40, 30));
        assert!(Step::new("x".into(), b"not a png".to_vec()).is_err());
    }

    #[test]
    fn formats_are_named() {
        assert_eq!(Format::parse("markdown"), Ok(Format::Markdown));
        assert_eq!(Format::parse("html"), Ok(Format::Html));
        assert_eq!(Format::parse("docx"), Ok(Format::Docx));
        assert_eq!(Format::parse("pptx"), Ok(Format::Pptx));
        assert!(Format::parse("pdf").is_err());
    }

    #[test]
    fn markdown_numbers_each_step_and_links_its_image() {
        let text = markdown("My guide", &steps(), "My guide images");
        assert!(text.starts_with("# My guide\n"));
        assert!(
            text.contains("## 1. Open the <File> menu\n\n![Step 1](<My guide images/step-01.png>)")
        );
        assert!(text.contains("## 2. Step 2\n"));
        assert!(text.contains("## 3. Click Save & close"));
        assert_eq!(
            markdown_text("G", &steps()),
            "# G\n\n1. Open the <File> menu\n2. Step 2\n3. Click Save & close\n"
        );
    }

    #[test]
    fn markdown_export_writes_an_images_folder() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("My guide.md");
        write(Format::Markdown, &path, "My guide", &steps()).unwrap();
        let images = dir.path().join("My guide images");
        for name in ["step-01.png", "step-02.png", "step-03.png"] {
            assert!(images.join(name).is_file(), "{name}");
        }
        assert!(fs::read_to_string(&path).unwrap().contains("step-03.png"));
    }

    #[test]
    fn html_is_one_file_with_its_images_inline() {
        let page = html("A & B", &steps());
        assert!(page.contains("<title>A &amp; B</title>"));
        assert!(page.contains("<h2>1. Open the &lt;File&gt; menu</h2>"));
        assert_eq!(page.matches("src=\"data:image/png;base64,").count(), 3);
    }

    #[test]
    fn images_are_shrunk_to_fit_keeping_their_shape() {
        assert_eq!(
            fit_emu(100, 50, (10_000_000, 10_000_000)),
            (952_500, 476_250)
        );
        let (cx, cy) = fit_emu(2000, 1000, (1_000_000, 1_000_000));
        assert_eq!(cx, 1_000_000);
        assert_eq!(cy, 500_000);
    }

    #[test]
    fn a_word_document_has_a_heading_and_image_per_step() {
        let bytes = docx("My guide", &steps()).unwrap();
        let files = names(&bytes);
        for name in [
            "[Content_Types].xml",
            "_rels/.rels",
            "word/document.xml",
            "word/_rels/document.xml.rels",
            "word/styles.xml",
            "word/media/step-01.png",
            "word/media/step-03.png",
        ] {
            assert!(files.iter().any(|file| file == name), "{name}");
        }
        let document = entry(&bytes, "word/document.xml");
        assert_eq!(document.matches("w:val=\"Heading1\"").count(), 3);
        assert!(document.contains("1. Open the &lt;File&gt; menu"));
        assert_eq!(document.matches("<wp:inline").count(), 3);
        assert!(entry(&bytes, "word/_rels/document.xml.rels").contains("media/step-02.png"));
        assert!(entry(&bytes, "_rels/.rels").contains("Target=\"word/document.xml\""));
    }

    #[test]
    fn a_deck_has_a_slide_per_step_after_the_title() {
        let bytes = pptx("My guide", &steps()).unwrap();
        let files = names(&bytes);
        for name in [
            "ppt/presentation.xml",
            "ppt/slideMasters/slideMaster1.xml",
            "ppt/slideLayouts/slideLayout1.xml",
            "ppt/theme/theme1.xml",
            "ppt/slides/slide4.xml",
            "ppt/media/step-03.png",
        ] {
            assert!(files.iter().any(|file| file == name), "{name}");
        }
        assert!(!files.iter().any(|file| file == "ppt/slides/slide5.xml"));
        assert_eq!(
            entry(&bytes, "ppt/presentation.xml")
                .matches("<p:sldId ")
                .count(),
            4
        );
        let slide = entry(&bytes, "ppt/slides/slide2.xml");
        assert!(slide.contains("1. Open the &lt;File&gt; menu"));
        assert!(slide.contains("<p:pic>") && slide.contains("r:embed=\"rId2\""));
        assert!(!slide.contains("pic:"));
        assert!(entry(&bytes, "ppt/slides/_rels/slide4.xml.rels").contains("../media/step-03.png"));
        assert!(entry(&bytes, "[Content_Types].xml").contains("/ppt/slides/slide4.xml"));
    }
}
