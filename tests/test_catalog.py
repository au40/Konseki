"""Catalog enrolment — what a session title becomes in the reading ledger.

The catalog auto-adds every distinct session title on sight and infers a
`reading_type` from the source. That inference decides which arm of
`book_equiv` the row scores through, and the two arms read *different columns*:
manga scores on `volumes`, everything else on `chars`.

Which is why the mis-filing mattered. `mangawari` reports no character count at
all, so a manga title filed as a 'book' scored `0 / 100_000` — zero, permanently,
no matter how many volumes were entered against it. These tests pin the source →
type mapping and the volume seeding that makes such a row score.

They also pin the **linearity** property (`TestGroupingIsFree`): because manga
scoring is `volumes / 7`, N one-volume rows total exactly the same as one
N-volume row. That is what makes grouping a series in the UI a purely cosmetic
change — it cannot move the book count. Anything that breaks it turns a display
tweak into a data migration.
"""
import sqlite3

import pytest

import catalog as cat
import db as db_mod
import imports as im


@pytest.fixture
def cat_db(seed):
    """Empty catalog.db alongside the suite's temp tracker.db.

    conftest wipes `sessions` but knows nothing about catalog.db — it is a
    separate file — so clear it here or rows leak between tests."""
    cat.init_catalog_db()
    assert str(cat.CATALOG_DB).startswith(str(cat.DATA_DIR)), "catalog must stay in the temp dir"
    con = sqlite3.connect(cat.CATALOG_DB)
    con.execute("DELETE FROM catalog")
    con.commit()
    con.close()
    return seed


def _row(name):
    con = sqlite3.connect(cat.CATALOG_DB)
    r = con.execute(
        "SELECT reading_type, chars, volumes, linked, hidden FROM catalog WHERE name=?",
        (name,),
    ).fetchone()
    con.close()
    return r


class TestTypeInference:
    def test_mangawari_title_is_filed_as_manga(self, cat_db):
        im.import_mangawari_day("極夜行", cat_db.day(1), 3600)
        cat.sync_catalog()
        rtype, chars, volumes, _, _ = _row("極夜行")
        assert rtype == "manga"
        assert chars == 0          # manga reports none, and none is invented
        assert volumes == 0        # read but not finished — visible, scores nothing

    def test_gsm_is_a_game_and_ttsu_is_a_book(self, cat_db):
        cat_db.gsm(cat_db.day(1), chars=5000, secs=3600, title="Game One")
        cat_db.session(cat_db.day(1), chars=8000, secs=3600,
                       source="ttsureader", title="Some Novel")
        cat.sync_catalog()
        assert _row("Game One")[0] == "game"
        assert _row("Some Novel")[0] == "book"

    def test_sources_with_no_opinion_still_fall_back_to_book(self, cat_db):
        """youtube/manual keep their historical behaviour — this change is
        narrow, and widening it is a separate decision."""
        im.import_youtube_day(cat_db.day(1), 1800)
        cat_db.session(cat_db.day(1), chars=0, secs=600,
                       source="manual", title="Hand logged")
        cat.sync_catalog()
        assert _row("YouTube")[0] == "book"
        assert _row("Hand logged")[0] == "book"

    def test_only_manga_gets_a_seeded_volume(self, cat_db):
        cat_db.gsm(cat_db.day(1), chars=5000, secs=3600, title="Game One")
        cat.sync_catalog()
        assert _row("Game One")[2] == 0

    def test_mangawari_wins_over_a_chars_bearing_source_on_one_title(self, cat_db):
        """Precedence is explicit, not alphabetical. A title read through both
        readers is manga — the volume is the meaningful unit for it."""
        cat_db.session(cat_db.day(2), chars=4000, secs=3600,
                       source="ttsureader", title="Both Ways")
        im.import_mangawari_day("Both Ways", cat_db.day(1), 1800)
        cat.sync_catalog()
        assert _row("Both Ways")[0] == "manga"


class TestScoring:
    def test_manga_row_scores_where_it_used_to_score_zero(self, cat_db):
        """The regression this change exists for: filed as a book, a chars-less
        manga row scored 0 whatever its volume count."""
        assert cat.book_equiv("book", 0, 7) == 0
        assert cat.book_equiv("manga", 0, 7) == 1

    def test_seven_finished_volumes_make_one_book(self, cat_db):
        for i in range(1, 8):
            im.import_mangawari_day(f"シリーズ {i}", cat_db.day(i), 1800)
        data = cat.get_catalog()
        assert len(data["rows"]) == 7
        assert all(r["reading_type"] == "manga" for r in data["rows"])
        assert data["total_books"] == 0     # read, but none finished yet

        for i in range(1, 8):
            db_mod.db_set_media_complete(f"シリーズ {i}", True)
        assert cat.get_catalog()["total_books"] == pytest.approx(1.0)


class TestGroupingIsFree:
    """The property the series-dropdown plan rests on.

    Manga scoring is linear in volumes, so *where* the volumes sit is
    immaterial: collapsing a series in the UI can never change the total. If
    this breaks, grouping stops being a display concern.
    """

    def test_n_single_volume_rows_equal_one_n_volume_row(self):
        split = sum(cat.book_equiv("manga", 0, 1) for _ in range(7))
        grouped = cat.book_equiv("manga", 0, 7)
        assert split == pytest.approx(grouped)

    def test_holds_for_a_partial_series_too(self):
        split = sum(cat.book_equiv("manga", 0, 1) for _ in range(3))
        grouped = cat.book_equiv("manga", 0, 3)
        assert split == pytest.approx(grouped)


class TestVolumesFollowCompletion:
    """The derived rail: a manga row's volume count IS its completion mark.

    Recomputed on every sync rather than nudged on the finish event, so the
    answer can't drift no matter how the user toggles it.
    """

    def _vols(self, name):
        cat.sync_catalog()
        return _row(name)[2]

    def test_finishing_makes_a_volume_count(self, cat_db):
        im.import_mangawari_day("巻二", cat_db.day(1), 1800)
        assert self._vols("巻二") == 0
        db_mod.db_set_media_complete("巻二", True)
        assert self._vols("巻二") == 1

    def test_unfinishing_takes_it_back_down(self, cat_db):
        im.import_mangawari_day("巻二", cat_db.day(1), 1800)
        db_mod.db_set_media_complete("巻二", True)
        assert self._vols("巻二") == 1
        db_mod.db_set_media_complete("巻二", False)
        assert self._vols("巻二") == 0

    def test_toggling_repeatedly_never_drifts(self, cat_db):
        """The reason this is derived and not incremented."""
        im.import_mangawari_day("巻二", cat_db.day(1), 1800)
        for _ in range(5):
            db_mod.db_set_media_complete("巻二", True)
            assert self._vols("巻二") == 1
            db_mod.db_set_media_complete("巻二", False)
            assert self._vols("巻二") == 0

    def test_finishing_a_non_manga_title_adds_no_volumes(self, cat_db):
        cat_db.session(cat_db.day(1), chars=9000, secs=3600,
                       source="ttsureader", title="Some Novel")
        db_mod.db_set_media_complete("Some Novel", True)
        assert self._vols("Some Novel") == 0     # books score on chars

    def test_a_hand_typed_volume_count_is_never_overwritten(self, cat_db):
        """Editing volumes takes the row off the derived rail for good."""
        im.import_mangawari_day("全集", cat_db.day(1), 1800)
        cat.sync_catalog()
        con = sqlite3.connect(cat.CATALOG_DB)
        rid = con.execute("SELECT id FROM catalog WHERE name=?", ("全集",)).fetchone()[0]
        con.close()

        cat.update_catalog_entry(rid, volumes=12)
        assert self._vols("全集") == 12           # sync leaves it alone
        db_mod.db_set_media_complete("全集", True)
        assert self._vols("全集") == 12           # and finishing doesn't reclaim it


class TestSeriesGrouping:
    """Series membership rides along on each row so the page can collapse it.

    The grouping is a display concern and these tests exist to keep it that way:
    every one of them asserts `total_books` is untouched by it.
    """

    def _books(self):
        return cat.get_catalog()["total_books"]

    def _by_name(self):
        return {r["name"]: r for r in cat.get_catalog()["rows"]}

    def test_ungrouped_rows_carry_no_series(self, cat_db):
        im.import_mangawari_day("単巻", cat_db.day(1), 1800)
        r = self._by_name()["単巻"]
        assert r["series_key"] == ""
        assert r["series_label"] == ""

    def test_members_share_a_key_and_a_label(self, cat_db):
        for i in (1, 2, 3):
            im.import_mangawari_day(f"連載 {i}", cat_db.day(i), 1800)
        cat_db.series("連載シリーズ", "連載 1", "連載 2", "連載 3")
        rows = self._by_name()
        keys = {rows[f"連載 {i}"]["series_key"] for i in (1, 2, 3)}
        assert len(keys) == 1 and keys != {""}
        assert all(rows[f"連載 {i}"]["series_label"] == "連載シリーズ" for i in (1, 2, 3))

    def test_an_unnamed_series_is_labelled_after_its_first_member(self, cat_db):
        """Matches how the media page and the lifetime views name it — the
        catalog must not invent a different label for the same series."""
        for i in (1, 2):
            im.import_mangawari_day(f"無名 {i}", cat_db.day(i), 1800)
        cat_db.series(None, "無名 1", "無名 2")
        assert self._by_name()["無名 1"]["series_label"] == "無名 1"

    def test_grouping_does_not_change_the_book_total(self, cat_db):
        for i in range(1, 8):
            im.import_mangawari_day(f"全 {i}", cat_db.day(i), 1800)
            db_mod.db_set_media_complete(f"全 {i}", True)
        before = self._books()
        assert before == pytest.approx(1.0)

        cat_db.series("全シリーズ", *[f"全 {i}" for i in range(1, 8)])
        assert self._books() == before          # the property, end to end

    def test_a_partly_finished_series_still_totals_per_row(self, cat_db):
        for i in range(1, 8):
            im.import_mangawari_day(f"途中 {i}", cat_db.day(i), 1800)
        for i in (1, 2, 3):
            db_mod.db_set_media_complete(f"途中 {i}", True)
        cat_db.series("途中シリーズ", *[f"途中 {i}" for i in range(1, 8)])
        assert self._books() == pytest.approx(3 / 7, abs=5e-4)

    def test_a_series_of_books_groups_without_touching_chars(self, cat_db):
        """Grouping is not manga-specific — it is safe for any series precisely
        because the chars arm is linear too."""
        for i in (1, 2):
            cat_db.session(cat_db.day(i), chars=50_000, secs=3600,
                           source="ttsureader", title=f"上下 {i}")
        before = self._books()
        cat_db.series("上下巻", "上下 1", "上下 2")
        assert self._books() == before == pytest.approx(1.0)


class TestExistingRowsAreLeftAlone:
    def test_type_is_only_decided_on_first_sight(self, cat_db):
        """Documented limitation, not an oversight: rows already filed as books
        keep that type. Re-typing them is a data edit the user asks for."""
        cat.add_catalog_entry("既刊", reading_type="book", chars=0, volumes=3)
        im.import_mangawari_day("既刊", cat_db.day(1), 1800)
        cat.sync_catalog()
        rtype, _, volumes, linked, _ = _row("既刊")
        assert rtype == "book"     # unchanged
        assert volumes == 3        # the user's number survives adoption
        assert linked == 1         # but it is now linked to the sessions

    def test_a_deleted_auto_row_stays_deleted(self, cat_db):
        """The existing escape hatch — tombstoned, not resurrected."""
        im.import_mangawari_day("捨てる巻", cat_db.day(1), 1800)
        cat.sync_catalog()
        con = sqlite3.connect(cat.CATALOG_DB)
        rid = con.execute("SELECT id FROM catalog WHERE name=?", ("捨てる巻",)).fetchone()[0]
        con.close()

        cat.delete_catalog_entry(rid)
        cat.sync_catalog()

        assert _row("捨てる巻")[4] == 1                      # still hidden
        assert all(r["name"] != "捨てる巻" for r in cat.get_catalog()["rows"])


class TestIdempotence:
    def test_repeated_syncs_do_not_multiply_volumes(self, cat_db):
        im.import_mangawari_day("巻一", cat_db.day(1), 1800)
        db_mod.db_set_media_complete("巻一", True)
        for _ in range(4):
            cat.sync_catalog()
        assert _row("巻一")[2] == 1
        # get_catalog rounds total_books to 3dp, so compare at that precision.
        assert cat.get_catalog()["total_books"] == pytest.approx(1 / 7, abs=5e-4)

    def test_more_reading_on_a_manga_title_does_not_add_volumes(self, cat_db):
        """One posted title is one volume however many sittings it takes."""
        im.import_mangawari_day("巻一", cat_db.day(2), 1800)
        db_mod.db_set_media_complete("巻一", True)
        cat.sync_catalog()
        im.import_mangawari_day("巻一", cat_db.day(1), 7200)
        cat.sync_catalog()
        assert _row("巻一")[2] == 1
