/**
 * Audit F15 re-audit round 2 (FAIL 7/10), ruling R3-6: the re-auditor's fresh false-positive corpus
 * (r2-fresh-fp.json, 120 lines of ordinary legal prose, English and Urdu), split by its 1-based line number.
 *
 * FRESH_TUNING holds the even-numbered lines: round 3 was tuned on these only. The odd-numbered lines were held out
 * and measured before they were looked at; they are added here, as regression rows, only after that measurement
 * (spec section 7, R3-6).
 *
 * Each row is [line number, language as the re-auditor labelled it, text]. "debatable" lines name a place at province
 * or district level; the spec rules that such a place is a general area (R3-5), so they must pass too.
 */

export type FreshRow = readonly [line: number, lang: string, text: string]

export const FRESH_TUNING: readonly FreshRow[] = [
  [2, "en", "The learned trial court framed the following issues on 05.11.2019."],
  [4, "en", "The plaintiff is the owner in possession of the suit property measuring 4 kanals 7 marlas."],
  [6, "en", "The appellant, son of a retired school teacher, has no previous criminal record."],
  [8, "en", "The mother of the minor applied for custody under section 25 of the Guardians and Wards Act, 1890."],
  [10, "en", "Learned counsel for the petitioner contends that the impugned order is without lawful authority."],
  [12, "en", "The accused persons, armed with pistols, entered the house of the complainant."],
  [14, "en", "The investigating officer prepared the site plan Ex.PC and recorded the statements under section 161 Cr.P.C."],
  [16, "en", "The bail petition was dismissed vide order dated 03.02.2022."],
  [18, "en", "Notice under Order V Rule 20 CPC was issued through publication in a daily newspaper."],
  [20, "en", "The tenant defaulted in payment of rent for the months of January to June 2021."],
  [22, "en", "The house in question is situated in a thickly populated area."],
  [24, "en", "The petitioner was posted as Assistant Commissioner in the year 2018."],
  [26, "en", "The applicant is ready to furnish surety bonds in the sum of Rs. 200,000/- with one surety."],
  [28, "en", "An amount of Rs. 3.5 million was allegedly misappropriated."],
  [30, "en", "The telephone call was made at about 9.30 p.m."],
  [32, "en", "The CNIC of the vendor was verified from NADRA."],
  [34, "en", "The accused was arrested from his house at 2.00 a.m."],
  [36, "en", "The son of the respondent was cross-examined at length."],
  [38, "en", "The wife of the petitioner filed a suit for dissolution of marriage on the ground of khula."],
  [40, "en", "Total land measuring 120 kanals is recorded in the name of the vendor."],
  [42, "en", "The matter is fixed for 21.11.2026 at 10:00 a.m. before the learned Single Judge."],
  [44, "en", "Present address: not known."],
  [46, "en", "The petitioner is the son of a Government servant."],
  [48, "en", "She is the daughter of a Member of the Provincial Assembly."],
  [50, "en", "The widow of late Shaheed Constable was paid compensation under the Policy."],
  [52, "en", "The accused is a resident of a different province."],
  [54, "en", "Accountability Court No. 3 decided Reference No. 123456789012 of 2019."],
  [56, "en", "The Commission comprising 3 members visited the site on 05.06.2021."],
  [58, "en", "The petitioner has been in custody since 14.02.2022."],
  [60, "en", "The petitioner [PARTY] is a resident of [PARTY]."],
  [62, "en", "Nos. 1 to 3 of the respondents are proforma respondents."],
  [64, "en", "The daughter of a Sessions Judge cannot be treated differently."],
  [66, "en", "The son of Adam principle was not argued."],
  [68, "en", "Flat No. 4 to Flat No. 9 of the project were never completed."],
  [70, "en", "Street No. 3 of the housing scheme remains unpaved."],
  [72, "debatable", "The petitioner is a resident of Punjab."],
  [74, "ur", "ملزم کی ضمانت بعد از گرفتاری کی درخواست منظور کی جاتی ہے۔"],
  [76, "ur", "مدعیہ کی بیٹی نابالغ ہے۔"],
  [78, "ur", "فریقین کے درمیان جائیداد کا تنازعہ ہے۔"],
  [80, "ur", "استغاثہ اپنا مقدمہ شک و شبہ سے بالاتر ثابت کرنے میں ناکام رہا۔"],
  [82, "ur", "گواہان استغاثہ کے بیانات میں تضاد پایا گیا۔"],
  [84, "ur", "متوفی کا بیٹا اور دختر عدالت میں پیش ہوئے۔"],
  [86, "ur", "وہ گاؤں کا پرانا ساکن ہے۔"],
  [88, "ur", "مکان کی چھت گر گئی تھی۔"],
  [90, "ur", "محلہ داروں نے پولیس کو اطلاع دی۔"],
  [92, "ur", "تھانہ صدر کی پولیس نے موقع پر پہنچ کر کارروائی کی۔"],
  [94, "ur", "شناختی کارڈ کی نقل منسلک ہے۔"],
  [96, "ur", "عدالت نے مقدمہ کی سماعت ۱۵ تاریخ تک ملتوی کر دی۔"],
  [98, "ur", "بیوہ اور یتیم بچوں کو وراثت میں حصہ دیا جائے۔"],
  [100, "ur", "دختر نیک اختر کی شادی کے اخراجات کا دعویٰ کیا گیا۔"],
  [102, "ur", "مدعیہ اپنے والد کے گھر میں رہائش پذیر ہے۔"],
  [104, "ur", "پسر نابالغ کی حضانت ماں کے پاس رہے گی۔"],
  [106, "ur", "رہائشی علاقہ میں کمرشل سرگرمی کی اجازت نہیں۔"],
  [108, "ur", "ساکن جائداد کی تقسیم کا مقدمہ زیر سماعت ہے۔"],
  [110, "ur", "فریق دوم اسی شہر کا رہائشی ہے۔"],
  [112, "ur", "کھیوٹ نمبر ۱۲۳ کھتونی نمبر ۴۵۶ کا انتقال درج کیا گیا۔"],
  [114, "ur", "مدعی کی دختر شادی شدہ ہے اور اپنے شوہر کے ساتھ رہتی ہے۔"],
  [116, "ur", "زوجہ مذکورہ نے نان نفقہ کا دعویٰ کیا۔"],
  [118, "ur", "رہائشی اسکیم کے پلاٹوں کی الاٹمنٹ منسوخ کر دی گئی۔"],
  [120, "ur", "بیوہ عورت کی جائیداد پر قبضہ کر لیا گیا۔"],
]
